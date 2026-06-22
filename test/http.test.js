const test = require("node:test");
const assert = require("node:assert");

const { parseRetryAfter } = require("../lib/http");

test("parseRetryAfter: numeric seconds", () => {
    assert.strictEqual(parseRetryAfter("120"), 120000);
    assert.strictEqual(parseRetryAfter("0"), 0);
});

test("parseRetryAfter: HTTP date in the future", () => {
    const future = new Date(Date.now() + 30000).toUTCString();
    const ms = parseRetryAfter(future);
    assert.ok(ms > 25000 && ms <= 31000, `expected ~30000, got ${ms}`);
});

test("parseRetryAfter: past date clamps to 0", () => {
    const past = new Date(Date.now() - 30000).toUTCString();
    assert.strictEqual(parseRetryAfter(past), 0);
});

test("parseRetryAfter: missing/garbage returns null", () => {
    assert.strictEqual(parseRetryAfter(null), null);
    assert.strictEqual(parseRetryAfter(""), null);
    assert.strictEqual(parseRetryAfter("not-a-date"), null);
});
