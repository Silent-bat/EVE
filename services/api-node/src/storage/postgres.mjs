import pg from "pg";
import { config } from "../config.mjs";
import { moduleLogger } from "../logger.mjs";
import { emptyState, ensureUserIn, mergePersistedUser, statePayload } from "./state.mjs";

const log = moduleLogger("storage.postgres");

// A liveness probe should fail fast rather than inherit the pool's budget.
const PING_TIMEOUT_MS = 3000;

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
  return pool;
}

export function createPool() {
  if (!config.databaseUrl) return null;
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
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
 * Idempotent schema bootstrap. Safe to run on every boot.
 */
export async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists auth_sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );

    create table if not exists app_state (
      user_id text primary key references users(id) on delete cascade,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists device_notifications (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      package_name text not null,
      app_name text,
      title text,
      body text,
      posted_at timestamptz not null,
      received_at timestamptz not null default now(),
      raw jsonb not null default '{}'::jsonb
    );

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
  const seeded = emptyState();
  const appStateRows = await pool.query("select user_id, payload from app_state");
  for (const row of appStateRows.rows) {
    mergePersistedUser(seeded, row.user_id, row.payload || {});
  }
  const userRows = await pool.query("select id, email from users");
  for (const row of userRows.rows) {
    ensureUserIn(seeded, row.id);
    seeded.users[row.id].email = row.email;
  }
  const notificationRows = await pool.query(
    `select id, user_id, package_name, app_name, title, body, posted_at, received_at, raw
     from device_notifications
     order by received_at desc
     limit 500`,
  );
  for (const row of notificationRows.rows) {
    seeded.deviceNotifications[row.user_id] ||= [];
    seeded.deviceNotifications[row.user_id].push({
      id: row.id,
      userId: row.user_id,
      packageName: row.package_name,
      appName: row.app_name || "",
      title: row.title || "",
      body: row.body || "",
      postedAt: row.posted_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      raw: row.raw || {},
    });
  }
  return seeded;
}

/**
 * Persist app_state per user. Caller owns the in-memory state shape.
 *
 * @param {import("./state.mjs").StateShape} state
 */
export async function saveToPostgres(state) {
  const activePool = pool;
  if (!activePool) throw new Error("postgres pool not initialized");
  // A user can sit in memory without a `users` row — a deleted account, or the
  // seeded local user. That row alone fails the app_state FK, and under
  // Promise.all one rejection fails every other user's save with it, so a
  // single stale entry blocks all writes and therefore all logins. The
  // `where exists` guard skips those rows instead of taking the save down.
  const results = await Promise.allSettled(
    Object.keys(state.users).map((userID) =>
      activePool.query(
        `insert into app_state (user_id, payload, updated_at)
         select $1, $2, now()
         where exists (select 1 from users where id = $1)
         on conflict (user_id) do update set payload = excluded.payload, updated_at = now()`,
        [userID, statePayload(state, userID)],
      ),
    ),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    log.warn(
      { failed: failed.length, total: results.length, err: failed[0].reason },
      "some user states failed to persist",
    );
    // Every write failing means the database is unusable, not that one row is
    // stale — surface that rather than reporting a successful save.
    if (failed.length === results.length) throw failed[0].reason;
  }
}
