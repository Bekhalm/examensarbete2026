require("dotenv").config();

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
    if (value === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

const PORT = num(process.env.PORT, 3000);
const HOST = process.env.HOST || "0.0.0.0";

// Hosts that bypass the SSRF private-network guard (e.g. the app's own origin,
// or any extra hosts set via ALLOWED_HOSTS for local testing).
const selfHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
]);
for (const h of (process.env.ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    selfHosts.add(h);
}

const config = {
    env: process.env.NODE_ENV || "development",
    port: PORT,
    host: HOST,

    // Polling / detection
    defaultCheckIntervalSec: num(process.env.DEFAULT_CHECK_INTERVAL_SEC, 60),
    minCheckIntervalSec: num(process.env.MIN_CHECK_INTERVAL_SEC, 20),
    maxBackoffSec: num(process.env.MAX_BACKOFF_SEC, 1800),
    schedulerTickMs: num(process.env.SCHEDULER_TICK_MS, 10_000),
    maxConcurrency: num(process.env.MAX_CONCURRENCY, 5),
    fetchTimeoutMs: num(process.env.FETCH_TIMEOUT_MS, 10_000),
    cooldownMs: num(process.env.COOLDOWN_MS, 60_000),
    maxItemsPerCheck: num(process.env.MAX_ITEMS_PER_CHECK, 40),
    seenItemsKeepPerSource: num(process.env.SEEN_ITEMS_KEEP_PER_SOURCE, 500),
    // Many large news sites (e.g. Sveriges Radio) sit behind a WAF that returns
    // 403 to obvious bot User-Agents. A normal browser UA gets through and is
    // standard practice for low-rate monitoring. Override via USER_AGENT.
    userAgent:
        process.env.USER_AGENT ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",

    // Security
    blockPrivateNetwork: bool(process.env.BLOCK_PRIVATE_NETWORK, true),
    allowedHosts: selfHosts,
    checkRateLimitPerMin: num(process.env.CHECK_RATE_LIMIT_PER_MIN, 30),

    // Access gate: a single shared password everyone logs in with. The username
    // is just a self-chosen label that scopes each person's own sources. When no
    // password is set the app runs open (no login) — handy for local dev.
    accessPassword: process.env.ACCESS_PASSWORD || "",
    // Secret used to sign the session cookie. Falls back to the access password
    // so a single .env value is enough to get going, but set it explicitly in
    // production so sessions survive a password change.
    sessionSecret: process.env.SESSION_SECRET || process.env.ACCESS_PASSWORD || "newsmonitor-dev-secret",
    // How long a login lasts on a device (default ~30 days).
    sessionMaxAgeMs: num(process.env.SESSION_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000),

    // Notifications (all optional — disabled if unset)
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || "",
    email: {
        smtpUrl: process.env.SMTP_URL || "",
        from: process.env.NOTIFY_EMAIL_FROM || "",
        to: process.env.NOTIFY_EMAIL_TO || "",
    },
    vapid: {
        publicKey: process.env.VAPID_PUBLIC_KEY || "",
        privateKey: process.env.VAPID_PRIVATE_KEY || "",
        subject: process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    },
};

config.authEnabled = !!config.accessPassword;

module.exports = config;
