/**
 * fingerprint.test.js
 * -------------------
 * content.js runs as a browser content script with top-level chrome.*
 * calls, so it can't be imported directly into a plain Node test without
 * mocking the entire chrome API surface. Instead, this file mirrors just
 * the fingerprint() function's algorithm — the part with actual
 * correctness stakes — and tests it in isolation.
 *
 * IMPORTANT: if you change the fingerprint algorithm in content.js
 * (the hash function, or what gets fed into it), update the copy below
 * to match, or these tests silently stop meaning anything.
 *
 * This exists because of a real bug found via manual walkthrough: hashing
 * only from+subject+snippet let two different email threads with
 * near-identical templated content (common for repeated trading/order
 * alerts) collide onto the same ID, silently swallowing the second one.
 * The "obvious" fix — using Gmail's thread ID alone — creates the
 * opposite bug: Gmail groups status-progression messages ("Order Placed"
 * -> "Executed" -> "Cancelled") into one thread, so a thread-ID-only key
 * would mean only the first message in a thread ever notifies. Folding
 * both together fixes both failure modes at once — that's what these
 * tests exist to guarantee stays true.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mirrors content.js's fingerprint() exactly.
function fingerprint(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

// Mirrors how content.js builds the input string fed into fingerprint().
function buildId({ threadId = "", from, subject, snippet }) {
  return fingerprint(`${threadId}|${from}|${subject}|${snippet.slice(0, 40)}`);
}

describe("message ID fingerprint", () => {
  test("two different threads with identical templated content do not collide", () => {
    const a = buildId({ threadId: "thread-AAA", from: "alerts@broker.com", subject: "Order Alert", snippet: "Your order has been placed" });
    const b = buildId({ threadId: "thread-BBB", from: "alerts@broker.com", subject: "Order Alert", snippet: "Your order has been placed" });
    assert.notEqual(a, b, "identical content in two different threads must produce different IDs");
  });

  test("different messages grouped into the same Gmail thread do not collide", () => {
    const placed = buildId({ threadId: "thread-CCC", from: "alerts@broker.com", subject: "Order Update", snippet: "Your order has been placed" });
    const executed = buildId({ threadId: "thread-CCC", from: "alerts@broker.com", subject: "Order Update", snippet: "Your order has been executed" });
    assert.notEqual(placed, executed, "different content within the same thread must produce different IDs");
  });

  test("re-scanning the exact same row produces the same ID (this is the dedupe we actually want)", () => {
    const first = buildId({ threadId: "thread-DDD", from: "alerts@broker.com", subject: "Order Update", snippet: "Your order has been placed" });
    const second = buildId({ threadId: "thread-DDD", from: "alerts@broker.com", subject: "Order Update", snippet: "Your order has been placed" });
    assert.equal(first, second, "an unchanged row scanned twice must dedupe to the same ID");
  });

  test("missing thread ID (fallback case) still produces a stable, non-empty ID", () => {
    const id = buildId({ from: "someone@example.com", subject: "Hello", snippet: "Test" });
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });
});
