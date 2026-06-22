const path = require("path");
const express = require("express");

const config = require("./lib/config");
const logger = require("./lib/logger");
const { acquireLock } = require("./lib/lock");
const db = require("./db/database");
const notifier = require("./services/notifier");
const render = require("./services/render");
const sourcesRouter = require("./routes/sources");
const { startScheduler } = require("./scheduler/scheduler");

const app = express();
app.set("trust proxy", true);
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
