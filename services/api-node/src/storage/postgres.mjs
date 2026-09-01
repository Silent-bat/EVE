import crypto from "node:crypto";
import pg from "pg";
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { emptyState, ensureUserIn, mergePersistedUser, statePayload } from "./state.mjs";

const log = moduleLogger("storage.postgres");

// A liveness probe should fail fast rather than inherit the pool's budget.
const PING_TIMEOUT_MS = 3000;
const MAX_OAUTH_ROWS = 10_000;
export const OAUTH_ADVISORY_LOCK = "eve:oauth-state";
export const STATE_SAVE_LOCK = "eve:state-save";
export const BACKGROUND_SWEEP_LOCK = "eve:background-sweep";

/** @type {Map<string, number | null>} */
const persistedVersions = new Map();
/** @type {Map<string, string>} */
const persistedHashes = new Map();

export class StateConflictError extends Error {
  /**
   * @param {string} [message]
   * @param {string | null} [userID]
   */
  constructor(message = "state changed in another API worker; retry the request", userID = null) {
    super(message);
    this.name = "StateConflictError";
    this.code = "STATE_CONFLICT";
    this.status = 409;
    // The facade uses this to refresh only the account that lost the compare
    // and swap. Keeping it on the typed error avoids parsing a user id out of
    // a human-facing message.
    this.userID = userID;
  }
}

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
  return pool;
}

export function createPool() {
  if (!config.databaseUrl) return null;
  persistedVersions.clear();
  persistedHashes.clear();
  let databaseHost = "";
  try {
    databaseHost = new URL(config.databaseUrl).hostname.toLowerCase();
  } catch {
    // config.mjs already validates DATABASE_URL as a URL; keep a defensive
    // fallback here in case this module is exercised with a test seam.
  }
  const localDatabase = ["localhost", "127.0.0.1", "::1", "postgres"].includes(databaseHost);
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // The Compose service is a local plaintext Postgres container. Remote
    // databases still get TLS with certificate verification by default; the
    // explicit flag is retained for providers that require a custom CA setup.
    ssl: localDatabase ? false : { rejectUnauthorized: config.databaseSSLRejectUnauthorized },
    // Without these, pg waits forever: a serverless database that drops a
    // TLS handshake leaves dead clients in the pool and every later acquire
    // queues behind them, so the whole API stops answering rather than
    // failing the one request that hit the blip.
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    idleTimeoutMillis: 30000,
    // save() fans out one query per user, so a small pool lets a single save
    // starve incoming requests. Neon's pooler endpoint handles this many.
    max: 20,
    // Neon closes idle connections on its own; keepalive keeps NAT paths warm
    // so we notice a dead socket at acquire time instead of mid-query.
    keepAlive: true,
  });
  // An idle client erroring emits on the pool, and an unhandled 'error' event
  // takes the process down. Log and let pg evict the client.
  pool.on("error", (error) => {
    log.warn({ err: error }, "idle database client errored; pool will evict it");
  });
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
  persistedVersions.clear();
  persistedHashes.clear();
}

export async function pingDatabase() {
  if (!pool) return false;
  try {
    // Health has to answer even when the database will not. The pool's own
    // connect timeout is longer than a probe should ever wait, so race it.
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ping timed out")), PING_TIMEOUT_MS).unref(),
      ),
    ]);
    return true;
  } catch (error) {
    log.warn({ err: error }, "database ping failed");
    return false;
  }
}

/**
 * Try to hold a process-wide Postgres advisory lock while a background job
 * runs. The lock is session-scoped (rather than transaction-scoped) because
 * the callback may call `save()`, which needs a separate pool connection.
 * Returning `acquired: false` lets another API replica skip its overlapping
 * timer tick instead of queueing duplicate Gmail/API work.
 *
 * @template T
 * @param {string} lockName
 * @param {() => Promise<T>} operation
 * @returns {Promise<{ acquired: boolean, value?: T }>}
 */
export async function tryWithPostgresAdvisoryLock(lockName, operation) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  if (typeof lockName !== "string" || !lockName) throw new Error("advisory lock name is required");
  const client = await activePool.connect();
  let acquired = false;
  try {
    const result = await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [lockName]);
    acquired = Boolean(result.rows[0]?.locked);
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await operation() };
  } finally {
    if (acquired) {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
      } catch (error) {
        log.warn({ err: error, lockName }, "failed to release advisory lock");
      }
    }
    client.release();
  }
}

/**
 * Idempotent schema bootstrap. Safe to run on every boot.
 */
export async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      password_hash text,
      -- NULL means a legacy row whose auth method predates this marker. New
      -- password accounts write TRUE and Google-only accounts write FALSE.
      password_auth_enabled boolean,
      created_at timestamptz not null default now()
    );
    -- Existing installations had a NOT NULL placeholder hash for Google-only
    -- users. Make the column nullable and add an explicit provider marker;
    -- legacy rows remain NULL so a real password can still be verified lazily.
    alter table users alter column password_hash drop not null;
    alter table users add column if not exists password_auth_enabled boolean;

    create table if not exists auth_sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
    create index if not exists auth_sessions_expires_idx on auth_sessions (expires_at);

    create table if not exists app_state (
      user_id text primary key references users(id) on delete cascade,
      payload jsonb not null,
      state_version bigint not null default 0,
      updated_at timestamptz not null default now()
    );
    alter table app_state add column if not exists state_version bigint not null default 0;

    create table if not exists oauth_states (
      state_key text primary key,
      user_id text references users(id) on delete cascade,
      mode text not null,
      return_to text not null default '',
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
    create index if not exists oauth_states_expires_idx on oauth_states (expires_at);
    -- Older installations created oauth_states before the user foreign key
    -- existed. Remove impossible rows first, then add the constraint
    -- idempotently so a stale worker can never recreate an account-scoped code.
    delete from oauth_states
     where user_id is not null
       and not exists (select 1 from users where users.id = oauth_states.user_id);
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        where t.relname = 'oauth_states'
          and c.conname = 'oauth_states_user_id_fkey'
      ) then
        alter table oauth_states
          add constraint oauth_states_user_id_fkey
          foreign key (user_id) references users(id) on delete cascade;
      end if;
    end $$;

    create table if not exists device_notifications (
      -- Notification listener keys are only unique on one device. The same
      -- Android package/key pair can legitimately arrive from two users, so
      -- identity is scoped to the owning account.
      id text not null,
      user_id text not null references users(id) on delete cascade,
      package_name text not null,
      app_name text,
      title text,
      body text,
      posted_at timestamptz not null,
      received_at timestamptz not null default now(),
      raw jsonb not null default '{}'::jsonb,
      primary key (user_id, id)
    );

    -- Older installations used a global PRIMARY KEY (id). Replace it with the
    -- account-scoped key above without assuming the autogenerated constraint
    -- name. The old global key guarantees that existing rows are compatible
    -- with the new composite key, and dropping that constraint also removes its
    -- unique index so it cannot keep rejecting equal IDs from other users.
    do $$
    declare
      primary_key_name text;
      primary_key_columns text[];
    begin
      select c.conname,
             array_agg(a.attname order by key_column.ordinality)
        into primary_key_name, primary_key_columns
        from pg_constraint c
        join pg_class table_ref on table_ref.oid = c.conrelid
        join pg_namespace namespace_ref on namespace_ref.oid = table_ref.relnamespace
        cross join lateral unnest(c.conkey) with ordinality as key_column(attnum, ordinality)
        join pg_attribute a
          on a.attrelid = table_ref.oid
         and a.attnum = key_column.attnum
       where c.contype = 'p'
         and table_ref.relname = 'device_notifications'
         and namespace_ref.nspname = current_schema()
       group by c.conname;

      if primary_key_name is not null
         and primary_key_columns <> array['user_id', 'id'] then
        execute format(
          'alter table %I.device_notifications drop constraint %I',
          current_schema(), primary_key_name
        );
        primary_key_name := null;
      end if;

      if primary_key_name is null then
        execute format(
          'alter table %I.device_notifications add constraint device_notifications_pkey primary key (user_id, id)',
          current_schema()
        );
      end if;
    end $$;

    create index if not exists device_notifications_user_received_idx
      on device_notifications (user_id, received_at desc);
  `);
}

/**
 * Read app_state + users + recent device notifications and assemble an
 * in-memory state object.
 *
 * @returns {Promise<import("./state.mjs").StateShape>}
 */
export async function loadFromPostgres() {
  if (!pool) throw new Error("postgres pool not initialized");
  // Keep expired bearer rows from accumulating between restarts. The query is
  // intentionally best-effort at load time; a read-only replica or a transient
  // database error should still surface through the normal load failure path.
  await pool.query("delete from auth_sessions where expires_at <= now()");
  await pool.query("delete from oauth_states where expires_at <= now()");
  const notificationCutoff = new Date(Date.now() - config.deviceNotificationRetentionDays * 86_400_000);
  await pool.query("delete from device_notifications where received_at < $1", [notificationCutoff]);
  const seeded = emptyState();
  const appStateRows = await pool.query("select user_id, payload, state_version from app_state");
  /** @type {Array<{ userID: string, entries: any[] }>} */
  const legacyNotifications = [];
  for (const row of appStateRows.rows) {
    if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
      throw new Error(`invalid app_state payload for user ${row.user_id}`);
    }
    // Notifications were embedded in early snapshots. Remove that field from
    // the state we hydrate and migrate it into the dedicated table below; this
    // prevents an old snapshot from reappearing after the user clears history.
    const payload = { ...row.payload };
    if (Array.isArray(payload.deviceNotifications)) {
      legacyNotifications.push({ userID: row.user_id, entries: payload.deviceNotifications });
    }
    delete payload.deviceNotifications;
    mergePersistedUser(seeded, row.user_id, payload);
  }
  await migrateLegacyNotifications(legacyNotifications, appStateRows.rows);
  const userRows = await pool.query("select id, email, password_hash, password_auth_enabled from users");
  for (const row of userRows.rows) {
    ensureUserIn(seeded, row.id);
    seeded.users[row.id].email = row.email;
    // Do not hydrate an ambiguous legacy hash into session-facing state: that
    // would expose Change Password for a Google-only account. Legacy password
    // users can still authenticate through the direct query and are classified
    // after a successful login.
    if (row.password_auth_enabled === true && typeof row.password_hash === "string" && row.password_hash) {
      seeded.users[row.id].passwordHash = row.password_hash;
    } else {
      delete seeded.users[row.id].passwordHash;
    }
  }
  // Notifications are table-authoritative in Postgres. Legacy rows were
  // migrated above; this query is the only source used for the hydrated list.
  const notificationRows = await pool.query(
    `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
     from (
       select d.*, row_number() over (partition by user_id order by received_at desc) as row_number
       from device_notifications d
       where d.received_at >= $1
     ) recent
     where row_number <= 100
     order by received_at desc`,
    [notificationCutoff],
  );
  for (const row of notificationRows.rows) {
    seeded.deviceNotifications[row.user_id] ||= [];
    const persisted = {
      id: row.id,
      userId: row.user_id,
      packageName: row.package_name,
      appName: row.app_name || "",
      title: row.title || "",
      body: row.body || "",
      postedAt: toISO(row.posted_at),
      receivedAt: toISO(row.received_at),
      raw: row.raw || {},
    };
    const existingIndex = seeded.deviceNotifications[row.user_id].findIndex(
      (entry) => entry?.id === persisted.id,
    );
    if (existingIndex >= 0) seeded.deviceNotifications[row.user_id][existingIndex] = persisted;
    else seeded.deviceNotifications[row.user_id].push(persisted);
    seeded.deviceNotifications[row.user_id].sort(
      (left, right) =>
        Date.parse(String(right?.receivedAt || "")) - Date.parse(String(left?.receivedAt || "")),
    );
    seeded.deviceNotifications[row.user_id] = seeded.deviceNotifications[row.user_id].slice(0, 100);
  }
  const oauthRows = await pool.query(
    "select state_key, user_id, mode, return_to, expires_at from oauth_states where expires_at > now()",
  );
  for (const row of oauthRows.rows) {
    seeded.oauthStates[row.state_key] = {
      userID: row.user_id || null,
      mode: row.mode,
      returnTo: row.return_to || "",
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
  // Keep the version/hash pair that was actually loaded. A later save updates
  // only snapshots changed by this worker and uses the version as an optimistic
  // concurrency token, so another worker's newer payload cannot be overwritten.
  persistedVersions.clear();
  persistedHashes.clear();
  const appStateByUser = new Map(appStateRows.rows.map((row) => [row.user_id, row]));
  for (const userID of Object.keys(seeded.users)) {
    const row = appStateByUser.get(userID);
    persistedVersions.set(userID, row ? parseStateVersion(row.state_version, userID) : null);
    persistedHashes.set(userID, snapshotHash(seeded, userID));
  }
  return seeded;
}

/**
 * Move notification arrays written by pre-table versions into the dedicated
 * table, then remove the legacy field from each app_state payload. The cleanup
 * is idempotent: retries use the notification's stable id and `on conflict`.
 *
 * @param {Array<{ userID: string, entries: any[] }>} groups
 * @param {Array<{ user_id: string, state_version?: number | string }>} appStateRows
 */
async function migrateLegacyNotifications(groups, appStateRows) {
  if (!pool || groups.length === 0) return;
  for (const group of groups) {
    const rows = group.entries
      .slice(0, 100)
      .map((entry, index) => normalizePersistedNotification(group.userID, entry, index))
      .filter((entry) => entry.title || entry.body);
    if (rows.length > 0) {
      await pool.query(
        `insert into device_notifications
          (id, user_id, package_name, app_name, title, body, posted_at, received_at, raw)
         select item.id, $1, item.package_name, item.app_name, item.title, item.body,
                item.posted_at, item.received_at, item.raw
         from jsonb_to_recordset($2::jsonb) as item(
           id text,
           package_name text,
           app_name text,
           title text,
           body text,
           posted_at timestamptz,
           received_at timestamptz,
           raw jsonb
         )
         on conflict (user_id, id) do nothing`,
        [group.userID, JSON.stringify(rows)],
      );
    }
    const cleaned = await pool.query(
      `update app_state
          set payload = payload - 'deviceNotifications',
              state_version = state_version + 1,
              updated_at = now()
        where user_id = $1 and payload ? 'deviceNotifications'
        returning state_version`,
      [group.userID],
    );
    const source = appStateRows.find((row) => row.user_id === group.userID);
    if (source && cleaned.rowCount) source.state_version = cleaned.rows[0].state_version;
  }
}

/**
 * Persist one OAuth nonce/handoff independently from the per-user snapshot.
 * OAuth credentials are consumed by a single SQL statement, so keeping these
 * writes separate prevents a stale in-memory snapshot in another API worker
 * from re-inserting a code that was already consumed.
 *
 * @param {string} stateKey
 * @param {{ userID?: string | null, mode?: string, returnTo?: string, expiresAt?: string }} entry
 */
export async function saveOAuthStateToPostgres(stateKey, entry) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  const expiresAt = Date.parse(String(entry?.expiresAt || ""));
  if (!stateKey || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("invalid OAuth state entry");
  }
  const client = await activePool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('${OAUTH_ADVISORY_LOCK}'))`);
    await client.query("delete from oauth_states where expires_at <= now()");
    const userID = typeof entry?.userID === "string" && entry.userID ? entry.userID : null;
    const mode = typeof entry?.mode === "string" && entry.mode ? entry.mode : "connect";
    const returnTo = typeof entry?.returnTo === "string" ? entry.returnTo : "";
    const result = await client.query(
      `insert into oauth_states (state_key, user_id, mode, return_to, expires_at)
       select $1, $2, $3, $4, $5
       where $2::text is null or exists (select 1 from users where id = $2)
       on conflict (state_key) do update
       set user_id = excluded.user_id,
           mode = excluded.mode,
           return_to = excluded.return_to,
           expires_at = excluded.expires_at`,
      [stateKey, userID, mode, returnTo, new Date(expiresAt)],
    );
    // A connect/handoff state must never survive for a deleted user. The
    // `where exists` guard makes this check atomic with the insert; callers get
    // an error instead of a redirect containing a code that can never work.
    if (!Number(result.rowCount || 0)) throw new Error("cannot persist OAuth state for missing user");
    // Keep abandoned public login attempts bounded across all API workers,
    // not just within the process that created the nonce.
    await client.query(
      `delete from oauth_states
       where state_key in (
         select state_key from oauth_states
         order by created_at desc, expires_at desc
         offset $1
       )`,
      [MAX_OAUTH_ROWS],
    );
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* best-effort */
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically consume an OAuth nonce or handoff. Exactly one concurrent worker
 * can receive the row; all other workers get null from DELETE ... RETURNING.
 *
 * @param {string} stateKey
 * @returns {Promise<{ userID: string, mode: string, returnTo: string, expiresAt: string } | null>}
 */
export async function consumeOAuthStateFromPostgres(stateKey) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  if (!stateKey) return null;
  const client = await activePool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('${OAUTH_ADVISORY_LOCK}'))`);
    const result = await client.query(
      `delete from oauth_states
       where state_key = $1 and expires_at > now()
       returning user_id, mode, return_to, expires_at`,
      [stateKey],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    const expiresAt = new Date(row.expires_at);
    const userID = row.user_id ? String(row.user_id) : "";
    const mode = String(row.mode || "");
    const validTimestamp = Number.isFinite(expiresAt.getTime());
    const validMode = ["login", "connect", "handoff"].includes(mode);
    let userExists = true;
    if (userID) {
      const userResult = await client.query("select 1 from users where id = $1", [userID]);
      userExists = Boolean(userResult.rowCount);
    }
    // Keep the validation in the same transaction/lock as DELETE. A purge
    // cannot remove the user between this check and the commit, and a stale
    // worker's orphaned row is consumed but never accepted.
    await client.query("commit");
    if (!validTimestamp || !validMode || !userExists) return null;
    return {
      userID,
      mode,
      returnTo: String(row.return_to || ""),
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* best-effort */
    }
    throw error;
  } finally {
    client.release();
  }
}

/** @param {unknown} value */
function toISO(value) {
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid persisted timestamp");
  return date.toISOString();
}

/**
 * Persist app_state per user. Caller owns the in-memory state shape.
 *
 * @param {import("./state.mjs").StateShape} state
 */
export async function saveToPostgres(state) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  const client = await activePool.connect();
  try {
    await client.query("begin");
    // All app_state writes are full snapshots. Serialize them across API
    // processes so two workers cannot interleave rows from different snapshots
    // and leave OAuth state or per-user payloads half from each writer.
    await client.query(`select pg_advisory_xact_lock(hashtext('${STATE_SAVE_LOCK}'))`);
    /** @type {Array<{ userID: string, payload: Record<string, any>, hash: string, version: number | null }>} */
    const changed = [];
    for (const userID of Object.keys(state.users)) {
      const { deviceNotifications: _ignoredNotifications, ...payload } = statePayload(state, userID);
      const hash = snapshotHash(state, userID);
      const version = persistedVersions.has(userID) ? persistedVersions.get(userID) : null;
      if (persistedHashes.get(userID) === hash) continue;
      changed.push({ userID, payload, hash, version: version ?? null });
    }

    /** @type {Array<{ userID: string, hash: string, version: number }>} */
    const saved = [];
    for (const item of changed) {
      if (item.version === null) {
        const result = await client.query(
          `insert into app_state (user_id, payload, state_version, updated_at)
           select $1, $2, 1, now()
           where exists (select 1 from users where id = $1)
           on conflict (user_id) do nothing
           returning state_version`,
          [item.userID, item.payload],
        );
        if (!result.rowCount)
          throw new StateConflictError(
            `state for ${item.userID} was created elsewhere or the account was deleted`,
            item.userID,
          );
        saved.push({ userID: item.userID, hash: item.hash, version: Number(result.rows[0].state_version) });
      } else {
        const result = await client.query(
          `update app_state
             set payload = $2,
                 state_version = state_version + 1,
                 updated_at = now()
           where user_id = $1 and state_version = $3
           returning state_version`,
          [item.userID, item.payload, item.version],
        );
        if (!result.rowCount)
          throw new StateConflictError(
            `state for ${item.userID} changed in another API worker or the account was deleted`,
            item.userID,
          );
        saved.push({ userID: item.userID, hash: item.hash, version: Number(result.rows[0].state_version) });
      }
    }
    await client.query("delete from auth_sessions where expires_at <= now()");
    await client.query("delete from oauth_states where expires_at <= now()");
    await client.query("commit");
    for (const item of saved) {
      persistedHashes.set(item.userID, item.hash);
      persistedVersions.set(item.userID, item.version);
    }
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* best-effort */
    }
    log.warn({ err: error }, "postgres state save failed");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reload one account from the authoritative Postgres rows after a failed
 * optimistic update. This deliberately does not call `loadFromPostgres()`:
 * reloading every user could discard unrelated unsaved mutations made by this
 * process while the conflicting request was in flight.
 *
 * @param {import("./state.mjs").StateShape} target
 * @param {string} userID
 * @returns {Promise<{ exists: boolean }>}
 */
export async function refreshUserFromPostgres(target, userID) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  if (typeof userID !== "string" || !userID) throw new Error("user id is required");

  const client = await activePool.connect();
  /** @type {import("./state.mjs").StateShape | null} */
  let fresh = null;
  /** @type {number | null} */
  let version = null;
  try {
    await client.query("begin");
    // Save transactions take this lock before comparing versions. Waiting for
    // it gives us the latest committed app-state payload before the reads.
    await client.query(`select pg_advisory_xact_lock(hashtext('${STATE_SAVE_LOCK}'))`);
    const userResult = await client.query(
      `select u.id, u.email, u.password_hash, u.password_auth_enabled,
              a.payload, a.state_version
       from users u
       left join app_state a on a.user_id = u.id
       where u.id = $1`,
      [userID],
    );
    const userRow = userResult.rows[0];
    if (!userRow) {
      await client.query("commit");
      removeUserSnapshot(target, userID);
      forgetPersistedUser(userID);
      return { exists: false };
    }

    let payload = userRow.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
    else payload = { ...payload };
    // Notification history is table-authoritative in Postgres. Do not hydrate
    // a legacy embedded array that another worker may already have cleared.
    if (payload && typeof payload === "object") delete payload.deviceNotifications;
    // Hydrate through a fresh container so fields removed by the other worker
    // (for example a cleared memory or preference) do not survive via merge.
    fresh = emptyState();
    mergePersistedUser(fresh, userID, /** @type {Record<string, any>} */ (payload));

    // The users table owns identity/auth fields. Never let an old app_state
    // payload restore a stale email or password capability.
    fresh.users[userID].email = userRow.email;
    if (
      userRow.password_auth_enabled === true &&
      typeof userRow.password_hash === "string" &&
      userRow.password_hash
    ) {
      fresh.users[userID].passwordHash = userRow.password_hash;
    } else {
      delete fresh.users[userID].passwordHash;
    }

    const notificationResult = await client.query(
      `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
       from device_notifications
       where user_id = $1
         and received_at >= $2
       order by received_at desc
       limit 100`,
      [userID, new Date(Date.now() - config.deviceNotificationRetentionDays * 86_400_000)],
    );
    fresh.deviceNotifications[userID] = notificationResult.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      packageName: String(row.package_name || ""),
      appName: String(row.app_name || ""),
      title: String(row.title || ""),
      body: String(row.body || ""),
      postedAt: toISO(row.posted_at),
      receivedAt: toISO(row.received_at),
      raw: row.raw && typeof row.raw === "object" ? row.raw : {},
    }));

    version =
      userRow.state_version === null || userRow.state_version === undefined
        ? null
        : parseStateVersion(userRow.state_version, userID);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* best-effort */
    }
    throw error;
  } finally {
    client.release();
  }

  if (!fresh) throw new Error(`failed to refresh state for user ${userID}`);
  target.users[userID] = fresh.users[userID];
  target.briefings[userID] = fresh.briefings[userID];
  target.audit[userID] = fresh.audit[userID];
  target.deviceNotifications[userID] = fresh.deviceNotifications[userID];
  persistedVersions.set(userID, version);
  persistedHashes.set(userID, snapshotHash(target, userID));
  return { exists: true };
}

/** @param {import("./state.mjs").StateShape} target @param {string} userID */
function removeUserSnapshot(target, userID) {
  delete target.users[userID];
  delete target.briefings[userID];
  delete target.audit[userID];
  delete target.deviceNotifications[userID];
  for (const [tokenHash, session] of Object.entries(target.sessions || {})) {
    if (session?.userID === userID) delete target.sessions[tokenHash];
  }
  for (const [stateKey, entry] of Object.entries(target.oauthStates || {})) {
    if (entry?.userID === userID) delete target.oauthStates[stateKey];
  }
}

/** @param {string} userID @param {any} entry @param {number} index */
function normalizePersistedNotification(userID, entry, index) {
  const packageName = notificationText(entry?.packageName, 120) || "unknown";
  const appName = notificationText(entry?.appName, 120);
  const title = notificationText(entry?.title, 240);
  const body = notificationText(entry?.body || entry?.text, 2_000);
  const identity = notificationText(entry?.id, 160);
  const id =
    identity ||
    `legacy-${crypto
      .createHash("sha256")
      .update(`${userID}:${index}:${JSON.stringify({ packageName, appName, title, body })}`)
      .digest("hex")
      .slice(0, 32)}`;
  const now = new Date();
  const postedAt = validPersistedDate(entry?.postedAt) || now;
  const receivedAt = validPersistedDate(entry?.receivedAt) || postedAt;
  return {
    id,
    package_name: packageName,
    app_name: appName || null,
    title: title || null,
    body: body || null,
    posted_at: postedAt.toISOString(),
    received_at: receivedAt.toISOString(),
    raw: {
      packageName,
      appName,
      title,
      body,
      postedAt: postedAt.toISOString(),
    },
  };
}

/** @param {unknown} value @param {number} max */
function notificationText(value, max) {
  if (typeof value !== "string") return "";
  // Avoid embedding control characters in JSONB or log-facing fields. Build
  // this one character at a time so the linter cannot mistake the sanitizer
  // for a regular expression that itself contains control escapes.
  let clean = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    clean += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return clean.replace(/\s+/g, " ").trim().slice(0, max);
}

/** @param {unknown} value @returns {Date | null} */
function validPersistedDate(value) {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Forget the optimistic-concurrency marker after a committed account delete.
 * A later login creates a new user id; retaining the old version would turn
 * that legitimate account creation into a false conflict.
 *
 * @param {string} userID
 */
export function forgetPersistedUser(userID) {
  persistedVersions.delete(userID);
  persistedHashes.delete(userID);
}

/** @param {unknown} value @param {string} userID @returns {number} */
function parseStateVersion(value, userID) {
  const version = Number(value ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`invalid state_version for user ${userID}`);
  }
  return version;
}

/** @param {import("./state.mjs").StateShape} state @param {string} userID */
function snapshotHash(state, userID) {
  const user = state.users[userID] || {};
  const { passwordHash: _ignoredPassword, ...safeUser } = user;
  // Notifications are stored in their own Postgres table and therefore are
  // intentionally excluded from app_state's optimistic snapshot.
  const payload = {
    user: safeUser,
    briefings: state.briefings[userID] || {},
    audit: state.audit[userID] || [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
