import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import pg from "pg";

// This file runs in its own node:test worker. Configure the Postgres module
// before its dynamic import, then replace only the pool connection method with
// a deterministic client. No database process or credentials are needed.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://conflict-test.invalid/eve";
process.env.LOG_LEVEL = "silent";

/** @type {{ query: (sql: string, params?: unknown[]) => Promise<any>, release: () => void } | null} */
let nextClient = null;
const connectMock = mock.method(pg.Pool.prototype, "connect", async () => {
  if (!nextClient) throw new Error("refresh test did not provide a client");
  return nextClient;
});
const postgres = await import(`../src/storage/postgres.mjs?conflict-test=${Date.now()}`);
const { emptyState, ensureUserIn } = await import("../src/storage/state.mjs");

/** @typedef {{ userRow?: Record<string, any> | null, notifications?: Record<string, any>[] }} Fixture */

/** @param {Fixture} fixture */
function fakeClient(fixture) {
  /** @type {Array<{ sql: string, params?: unknown[] }>} */
  const queries = [];
  return {
    queries,
    async query(/** @type {string} */ sql, /** @type {unknown[] | undefined} */ params) {
      queries.push({ sql, params });
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from users u")) {
        return { rows: fixture.userRow ? [fixture.userRow] : [], rowCount: fixture.userRow ? 1 : 0 };
      }
      if (sql.includes("from device_notifications")) {
        return { rows: fixture.notifications || [], rowCount: (fixture.notifications || []).length };
      }
      throw new Error(`unexpected SQL in refresh test: ${sql}`);
    },
    release() {},
  };
}

test("refreshUserFromPostgres swaps in the remote snapshot and marker", async () => {
  const client = fakeClient({
    userRow: {
      id: "conflict-user",
      email: "remote@example.com",
      password_hash: null,
      password_auth_enabled: false,
      payload: {
        user: { displayName: "Remote name", deviceNotifications: [{ id: "stale" }] },
        briefings: { today: { id: "remote-briefing" } },
        audit: [{ id: "remote-audit" }],
      },
      state_version: "7",
    },
    notifications: [
      {
        id: "remote-notification",
        user_id: "conflict-user",
        package_name: "com.example.mail",
        app_name: "Mail",
        title: "Remote notification",
        body: "Only the table row is authoritative",
        posted_at: new Date("2026-08-30T10:00:00.000Z"),
        received_at: new Date("2026-08-30T10:01:00.000Z"),
        raw: { source: "postgres" },
      },
    ],
  });
  nextClient = client;
  postgres.createPool();

  const target = emptyState();
  ensureUserIn(target, "conflict-user");
  ensureUserIn(target, "unrelated-user");
  target.users["conflict-user"].displayName = "Stale name";
  target.deviceNotifications["conflict-user"] = [{ id: "local-stale" }];
  target.users["unrelated-user"].displayName = "Keep this local mutation";

  const result = await postgres.refreshUserFromPostgres(target, "conflict-user");

  assert.deepEqual(result, { exists: true });
  assert.equal(target.users["conflict-user"].displayName, "Remote name");
  assert.equal(target.users["conflict-user"].email, "remote@example.com");
  assert.deepEqual(target.briefings["conflict-user"], { today: { id: "remote-briefing" } });
  assert.deepEqual(target.audit["conflict-user"], [{ id: "remote-audit" }]);
  assert.deepEqual(
    target.deviceNotifications["conflict-user"].map((entry) => entry.id),
    ["remote-notification"],
  );
  assert.equal(target.users["unrelated-user"].displayName, "Keep this local mutation");
  assert.ok(
    client.queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock(hashtext('eve:state-save'))")),
    "refresh must coordinate with state writers",
  );

  await postgres.closePool();
});

test("refreshUserFromPostgres removes a remotely deleted account", async () => {
  const client = fakeClient({ userRow: null });
  nextClient = client;
  postgres.createPool();

  const target = emptyState();
  ensureUserIn(target, "deleted-conflict-user");
  target.sessions["session-hash"] = {
    userID: "deleted-conflict-user",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  target.oauthStates["handoff"] = { userID: "deleted-conflict-user", mode: "handoff" };

  const result = await postgres.refreshUserFromPostgres(target, "deleted-conflict-user");

  assert.deepEqual(result, { exists: false });
  assert.equal(target.users["deleted-conflict-user"], undefined);
  assert.equal(target.sessions["session-hash"], undefined);
  assert.equal(target.oauthStates.handoff, undefined);
  await postgres.closePool();
});

test("state conflicts identify the account that needs refreshing", () => {
  const error = new postgres.StateConflictError("conflict", "conflict-user");
  assert.equal(error.name, "StateConflictError");
  assert.equal(error.code, "STATE_CONFLICT");
  assert.equal(error.status, 409);
  assert.equal(error.userID, "conflict-user");
});

after(() => connectMock.mock.restore());
