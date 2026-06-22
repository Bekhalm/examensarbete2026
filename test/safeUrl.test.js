const { test } = require("node:test");
const assert = require("node:assert");
const { isPrivateIp, assertSafeUrl } = require("../lib/safeUrl");

test("isPrivateIp flags private/loopback/link-local ranges", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("10.0.0.5"), true);
    assert.equal(isPrivateIp("172.16.4.4"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("169.254.10.1"), true);
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("not-an-ip"), true);
});

test("isPrivateIp allows public addresses", () => {
    assert.equal(isPrivateIp("8.8.8.8"), false);
    assert.equal(isPrivateIp("1.1.1.1"), false);
});

test("assertSafeUrl rejects non-http protocols", async () => {
    await assert.rejects(() => assertSafeUrl("ftp://example.com"), /http/i);
    await assert.rejects(() => assertSafeUrl("file:///etc/passwd"));
});

test("assertSafeUrl blocks loopback addresses", async () => {
    await assert.rejects(() => assertSafeUrl("http://127.0.0.1/admin"));
});
