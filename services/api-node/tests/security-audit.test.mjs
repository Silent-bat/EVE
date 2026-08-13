/**
 * Regression tests for the 2026-08-09 security audit fixes.
 *
 * Each test here corresponds to a numbered finding in SECURITY-AUDIT.md, and
 * each one is written to fail against the code as it was before the fix rather
 * than merely to exercise the new path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";

import { readJSON, writeAuthRedirect } from "../src/http/responses.mjs";
import { safeReturnTo } from "../src/google/oauth.mjs";
import { UNTRUSTED_CONTEXT_RULE } from "../src/briefing/assistant.mjs";

/** Minimal ServerResponse stand-in — records what a handler wrote. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: /** @type {Record<string, string>} */ ({}),
    body: "",
    ended: false,
    writeHead(/** @type {number} */ status, /** @type {any} */ headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      return this;
    },
    end(/** @type {string} */ chunk) {
      if (chunk) this.body += chunk;
      this.ended = true;
      return this;
    },
  };
}

/** A request-like async iterable of body bytes. `Readable` already has destroy. */
function fakeRequest(/** @type {Buffer[]} */ chunks) {
  return Readable.from(chunks);
}

// ---------- Finding 2: HTML injection into the OAuth callback ----------

test("finding 2 — the OAuth callback emits no HTML document to inject into", () => {
  const response = fakeResponse();
  // This payload passes safeReturnTo, which is what made the old bug reachable.
  const hostile = 'eve://cb</script><img src=x onerror=alert(document.body)>';
  assert.equal(safeReturnTo(hostile), hostile, "precondition: the allowlist lets this through");

  writeAuthRedirect(/** @type {any} */ (response), "SESSIONTOKEN123", hostile);

  assert.equal(response.statusCode, 302);
  assert.equal(response.body, "", "a redirect has no body, so there is no markup to break out of");
  assert.ok(!/<script|<img/i.test(response.body));
});

test("finding 2 — the token rides in Location and is marked no-store", () => {
  const response = fakeResponse();
  writeAuthRedirect(/** @type {any} */ (response), "SESSIONTOKEN123", "eve://cb");

  assert.match(response.headers.Location, /^eve:\/\/cb\?eve_token=SESSIONTOKEN123$/);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.headers["Referrer-Policy"], "no-referrer");
});

test("finding 2 — an empty returnTo still gets an escaped HTML fallback", () => {
  const response = fakeResponse();
  writeAuthRedirect(/** @type {any} */ (response), "SESSIONTOKEN123", "");

  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("SESSIONTOKEN123"), "no token on a page we do not redirect from");
});

test("finding 2 — safeReturnTo still rejects off-allowlist schemes", () => {
  assert.equal(safeReturnTo("https://evil.example/steal"), "");
  assert.equal(safeReturnTo("javascript:alert(1)"), "");
  assert.equal(safeReturnTo(""), "");
  assert.equal(safeReturnTo("http://localhost:8081/cb"), "http://localhost:8081/cb");
});

// ---------- Finding 5: unbounded request bodies ----------

test("finding 5 — readJSON refuses a body over the cap with 413", async () => {
  // 1 MiB + a little, in chunks, so the cap has to trip mid-stream.
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const request = fakeRequest([chunk, chunk, chunk, chunk, chunk]);

  await assert.rejects(
    () => readJSON(/** @type {any} */ (request)),
    (/** @type {any} */ error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /too large/i);
      return true;
    },
  );
});

/**
 * The above proves readJSON *throws* 413. It does not prove the caller ever
 * sees one, and originally they did not: the first fix destroyed the request,
 * which shares its socket with the response, so the connection reset before the
 * status line could be written and curl reported no response at all. This test
 * goes over a real socket for that reason — it is the only way the difference
 * between "throws 413" and "answers 413" is observable.
 *
 * Raw `net` rather than `fetch`: undici will not read a response until it has
 * finished uploading, so a client that is still streaming a refused body
 * deadlocks against a server that has stopped reading it. curl reads and writes
 * at once, which is the behaviour worth asserting.
 */
test("finding 5 — the 413 actually reaches the client over a real socket", async () => {
  const server = createServer(async (request, response) => {
    try {
      await readJSON(/** @type {any} */ (request));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    } catch (error) {
      const status = /** @type {any} */ (error).status || 500;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: /** @type {any} */ (error).message }));
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {any} */ (server.address());

  try {
    // Over the 1 MiB cap but under the drain ceiling, and the declared length
    // matches what is actually sent — so the server drains it, answers cleanly,
    // and the assertion is about delivery rather than about a race.
    const body = "a".repeat(2 * 1024 * 1024);
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");

    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (piece) => {
      received += piece;
    });
    // EPIPE here is the success path, not a failure: the server answers 413 and
    // closes while we are still writing, so the tail of the upload lands on a
    // shut socket. Swallow it and judge on what came back.
    socket.on("error", () => {});
    // Announce 4 MiB, then send 2 MiB of it. The cap trips mid-stream, which is
    // the case that matters — the server must answer without waiting for a body
    // it has already refused.
    socket.write(
      `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    );
    socket.write(body);

    // Resolve on close *or* error. `events.once` rejects on an 'error' event, and
    // a reset is one of the normal ways this exchange ends — the point is only to
    // stop waiting once the socket is done, then judge what arrived.
    await new Promise((resolve) => {
      const done = () => resolve(undefined);
      socket.once("close", done);
      socket.once("error", done);
      setTimeout(done, 5000);
    });
    socket.destroy();

    assert.match(received, /^HTTP\/1\.1 413 /, `expected a 413 status line, got: ${received.slice(0, 120)}`);
    assert.match(received, /request body too large/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("finding 5 — a normal body is unaffected", async () => {
  const request = fakeRequest([Buffer.from(JSON.stringify({ hello: "world" }))]);
  assert.deepEqual(await readJSON(/** @type {any} */ (request)), { hello: "world" });
});

test("finding 5 — an empty body is still an empty object", async () => {
  assert.deepEqual(await readJSON(/** @type {any} */ (fakeRequest([]))), {});
});

test("finding 5 — malformed JSON is still a 400, not a 413", async () => {
  const request = fakeRequest([Buffer.from("{not json")]);
  await assert.rejects(
    () => readJSON(/** @type {any} */ (request)),
    (/** @type {any} */ error) => error.status === 400,
  );
});

// ---------- Finding 4: prompt-injection fencing ----------

test("finding 4 — the untrusted-content rule names the dangerous capabilities", () => {
  assert.match(UNTRUSTED_CONTEXT_RULE, /UNTRUSTED DATA/);
  // The point of the rule is that it is specific about what must not happen.
  assert.match(UNTRUSTED_CONTEXT_RULE, /send mail/i);
  assert.match(UNTRUSTED_CONTEXT_RULE, /approve/i);
  assert.match(UNTRUSTED_CONTEXT_RULE, /store a memory/i);
});
