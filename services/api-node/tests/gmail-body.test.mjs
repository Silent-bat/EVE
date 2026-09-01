/**
 * Tests for Gmail body extraction.
 *
 * The bug these cover: `decodeGmailBody` used to return the first part in the
 * MIME tree that carried bytes. Multipart mail sends the same content twice
 * (text/plain and text/html), and marketing senders commonly list the HTML
 * first — so the "body" arrived as raw `<!DOCTYPE html …>` markup and was fed
 * to the urgency heuristics, the LLM prompt, and the user's screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeGmailBody, scrubText, stripHTML } from "../src/google/api.mjs";

/** @param {string} text */
const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");

/** @param {string} mimeType @param {string} text */
const part = (mimeType, text) => ({ mimeType, body: { data: b64(text) } });

test("prefers text/plain even when text/html is listed first", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      part("text/html", "<html><body><p>Hello <b>there</b></p></body></html>"),
      part("text/plain", "Hello there"),
    ],
  };
  assert.equal(decodeGmailBody(payload), "Hello there");
});

test("falls back to text/html with the markup stripped", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      part(
        "text/html",
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">' +
          "<html><head><style>.a{color:red}</style><title>Ignore</title></head>" +
          "<body><p>Your invoice is ready.</p></body></html>",
      ),
    ],
  };
  assert.equal(decodeGmailBody(payload), "Your invoice is ready.");
});

test("finds text/plain nested below a multipart/mixed wrapper", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [part("text/html", "<p>Nested</p>"), part("text/plain", "Nested")],
      },
      { mimeType: "application/pdf", filename: "invoice.pdf", body: { data: b64("%PDF-1.4") } },
    ],
  };
  assert.equal(decodeGmailBody(payload), "Nested");
});

test("never returns attachment bytes as the body", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attached text") } },
      part("text/plain", "real body"),
    ],
  };
  assert.equal(decodeGmailBody(payload), "real body");
});

test("handles a single-part plain message", () => {
  assert.equal(decodeGmailBody(part("text/plain", "Just a line")), "Just a line");
});

test("strips markup when the sender omits mimeType entirely", () => {
  const payload = { parts: [{ body: { data: b64("<div>No type declared</div>") } }] };
  assert.equal(decodeGmailBody(payload), "No type declared");
});

test("returns empty string for an absent or bodyless payload", () => {
  assert.equal(decodeGmailBody(null), "");
  assert.equal(decodeGmailBody({ mimeType: "multipart/mixed", parts: [] }), "");
});

test("scrubs preheader padding out of a text/plain part", () => {
  // Real shape from a job-alert sender: the plain-text alternative is padded
  // with runs of &zwnj; and U+034F so the inbox preview line looks longer.
  const padded =
    "Your job alert has new matches!" + " &zwnj;".repeat(6) + "\u034f".repeat(8) + " Fabletics is hiring.";
  const payload = { mimeType: "multipart/alternative", parts: [part("text/plain", padded)] };
  assert.equal(decodeGmailBody(payload), "Your job alert has new matches! Fabletics is hiring.");
});

test("scrubText leaves plain-text angle brackets alone", () => {
  // A text/plain body legitimately carries bare URLs and addresses in angle
  // brackets — stripping tags here would eat them.
  const body = "Reply to <rosnel@example.com> or see <https://example.com/jobs>.";
  assert.equal(scrubText(body), body);
  assert.equal(decodeGmailBody(part("text/plain", body)), body);
});

test("scrubText decodes entities that appear in plain-text parts", () => {
  assert.equal(scrubText("Tom &amp; Jerry &mdash; 50&#37; off"), "Tom & Jerry — 50% off");
});

test("stripHTML drops script and style content", () => {
  const html = "<script>var a = 1 < 2;</script><style>p{margin:0}</style><p>Only this</p>";
  assert.equal(stripHTML(html), "Only this");
});

test("stripHTML decodes named and numeric entities", () => {
  assert.equal(
    stripHTML("<p>Tom &amp; Jerry &mdash; 50&#37; off &#x2014; &quot;now&quot;</p>"),
    'Tom & Jerry — 50% off — "now"',
  );
});

test("stripHTML removes zero-width preheader padding", () => {
  const html = "<div>Deal​‌‍﻿ inside</div>";
  assert.equal(stripHTML(html), "Deal inside");
});

test("stripHTML collapses the whitespace tags leave behind", () => {
  const html = "<table><tr><td>  A  </td><td>\n\nB\t</td></tr></table>";
  assert.equal(stripHTML(html), "A B");
});

test("stripHTML leaves unknown entities alone rather than eating them", () => {
  assert.equal(stripHTML("<p>&notarealentity; stays</p>"), "&notarealentity; stays");
});

test("stripHTML is a no-op on text that was never markup", () => {
  assert.equal(stripHTML("Plain sentence, 1 < 2 & fine."), "Plain sentence, 1 < 2 & fine.");
});
