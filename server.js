const path = require("path");
const crypto = require("crypto");
const express = require("express");

const config = require("./lib/config");
const logger = require("./lib/logger");
const { acquireLock } = require("./lib/lock");
const { normalizeSpace } = require("./lib/space");
const db = require("./db/database");
const notifier = require("./services/notifier");
const render = require("./services/render");
const sourcesRouter = require("./routes/sources");
const { startScheduler } = require("./scheduler/scheduler");

const app = express();
app.set("trust proxy", true);

// Decode the HTTP Basic Auth credentials into { user, pass }.
function basicAuth(req) {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme !== "Basic" || !encoded) return null;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// Optional shared-password gate (HTTP Basic Auth). Enabled when ACCESS_PASSWORD
// is set. Protects every route except /health so uptime checks still work.
// The USERNAME becomes the person's "space" (their initials/name), so each
// colleague logs in with their own initials + the shared password and gets
// their own private source list. Only the password must match.
function passwordMatches(supplied) {
    const a = Buffer.from(supplied);
    const b = Buffer.from(config.accessPassword);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (config.accessPassword) {
    app.use((req, res, next) => {
        if (req.path === "/health") return next();
        const creds = basicAuth(req);
        if (creds && passwordMatches(creds.pass)) {
            req.authUser = creds.user;
            return next();
        }
        res.set(
            "WWW-Authenticate",
            'Basic realm="Logga in: dina initialer som anvandarnamn + losenord", charset="UTF-8"'
        );
        return res.status(401).send("Logga in med dina initialer (användarnamn) och lösenord.");
    });
}

// Resolve the caller's space once, for every route. Prefer the authenticated
// username (when the password gate is on); otherwise fall back to the X-Space
// header / query used by the in-app name prompt.
app.use((req, _res, next) => {
    const fromAuth = normalizeSpace(req.authUser || "");
    req.space = fromAuth || normalizeSpace(req.get("X-Space") || req.query.space || "");
    next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (_req, res) => {
    res.json({ status: "ok", env: config.env });
});

app.use("/api", sourcesRouter);

// ---------- demo source (for testing change detection) ----------
let demoVersion = 1;
app.get("/demo/source", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="sv"><head><meta charset="utf-8" /><title>Demo Source</title></head>
<body><main><h1>Demo Source</h1>
<p><strong>Version:</strong> ${demoVersion}</p>
<p>Sida för att testa change detection vid examination.</p></main></body></html>`);
});
app.post("/demo/bump", (_req, res) => {
    demoVersion += 1;
    res.json({ ok: true, demoVersion });
});

async function start() {
    // Refuse to start if another instance is already running (prevents a stray
    // second server from fighting over and corrupting the database).
    let releaseLock;
    try {
        releaseLock = acquireLock();
    } catch (err) {
        if (err.code === "already_running") {
            logger.error(err.message);
            process.exit(1);
        }
        throw err;
    }

    await db.migrate();
    notifier.init();

    const server = app.listen(config.port, config.host, () => {
        logger.info(`Server is running on http://localhost:${config.port}`);
    });
    server.on("error", (err) => {
        logger.error({ err: err.message }, "server failed to bind");
        releaseLock();
        process.exit(1);
    });

    const stopScheduler = startScheduler();

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, "shutting down");
        stopScheduler();
        releaseLock();
        await render.close().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("exit", () => { if (releaseLock) releaseLock(); });
}

start().catch((err) => {
    logger.error({ err: err.message }, "failed to start");
    process.exit(1);
});
