const test = require("node:test");
const assert = require("node:assert");

const config = require("../lib/config");
const { effectiveIntervalMs, isDue } = require("../scheduler/scheduler");

const BASE = config.defaultCheckIntervalSec * 1000;
const CAP = config.maxBackoffSec * 1000;

test("effectiveIntervalMs: no failures uses the base interval", () => {
    assert.strictEqual(effectiveIntervalMs({ consecutive_failures: 0 }), BASE);
    assert.strictEqual(effectiveIntervalMs({}), BASE);
});

test("effectiveIntervalMs: respects a per-source interval over the default", () => {
    const custom = Math.max(config.minCheckIntervalSec, 300);
    assert.strictEqual(
        effectiveIntervalMs({ check_interval_sec: custom, consecutive_failures: 0 }),
        custom * 1000
    );
});

test("effectiveIntervalMs: backs off exponentially with failures", () => {
    assert.strictEqual(effectiveIntervalMs({ consecutive_failures: 1 }), BASE * 2);
    assert.strictEqual(effectiveIntervalMs({ consecutive_failures: 2 }), BASE * 4);
    assert.strictEqual(effectiveIntervalMs({ consecutive_failures: 3 }), BASE * 8);
});

test("effectiveIntervalMs: never exceeds the backoff cap", () => {
    assert.strictEqual(effectiveIntervalMs({ consecutive_failures: 100 }), CAP);
    assert.ok(effectiveIntervalMs({ consecutive_failures: 20 }) <= CAP);
});

test("isDue: a never-checked source is due", () => {
    assert.strictEqual(isDue({ consecutive_failures: 0 }, Date.now()), true);
});

test("isDue: not due before the interval elapses", () => {
    const now = Date.now();
    const last = new Date(now - (BASE - 5000)).toISOString();
    assert.strictEqual(isDue({ last_checked_at: last, consecutive_failures: 0 }, now), false);
});

test("isDue: due once the interval has elapsed", () => {
    const now = Date.now();
    const last = new Date(now - (BASE + 5000)).toISOString();
    assert.strictEqual(isDue({ last_checked_at: last, consecutive_failures: 0 }, now), true);
});

test("isDue: a future Retry-After window blocks the check", () => {
    const now = Date.now();
    const last = new Date(now - (BASE + 60000)).toISOString(); // long overdue
    const next = new Date(now + 60000).toISOString(); // but told to wait
    assert.strictEqual(isDue({ last_checked_at: last, next_retry_at: next, consecutive_failures: 0 }, now), false);
});

test("isDue: a past Retry-After window no longer blocks", () => {
    const now = Date.now();
    const last = new Date(now - (BASE + 60000)).toISOString();
    const next = new Date(now - 1000).toISOString();
    assert.strictEqual(isDue({ last_checked_at: last, next_retry_at: next, consecutive_failures: 0 }, now), true);
});
