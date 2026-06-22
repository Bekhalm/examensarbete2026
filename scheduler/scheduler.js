const config = require("../lib/config");
const logger = require("../lib/logger");
const sse = require("../services/sse");
const { getActiveSources } = require("../db/database");
const { checkOneSourceById } = require("../services/changeDetector");

function baseIntervalMs(source) {
    const sec = Math.max(config.minCheckIntervalSec, source.check_interval_sec || config.defaultCheckIntervalSec);
    return sec * 1000;
}

// After repeated failures, back off exponentially (2^failures) up to a cap, so
// we stop hammering a site that's down or rate-limiting us.
function effectiveIntervalMs(source) {
    const base = baseIntervalMs(source);
    const fails = source.consecutive_failures || 0;
    if (fails <= 0) return base;
    const capMs = config.maxBackoffSec * 1000;
    const factor = Math.min(2 ** Math.min(fails, 16), Math.max(1, Math.ceil(capMs / base)));
    return Math.min(base * factor, capMs);
}

function isDue(source, nowMs) {
    // Explicit Retry-After window from a 429/503 response takes priority.
    if (source.next_retry_at) {
        const t = Date.parse(source.next_retry_at);
        if (!Number.isNaN(t) && t > nowMs) return false;
    }
    const last = source.last_checked_at ? Date.parse(source.last_checked_at) : 0;
    return nowMs - last >= effectiveIntervalMs(source);
}

// Run an async worker over items with a bounded number of parallel runners.
async function runWithConcurrency(items, limit, worker) {
    const queue = [...items];
    const n = Math.max(1, Math.min(limit, queue.length));
    const runners = Array.from({ length: n }, async () => {
        while (queue.length) {
            const item = queue.shift();
            try {
                await worker(item);
            } catch (err) {
                logger.error({ err: err.message }, "worker error");
            }
        }
    });
    await Promise.all(runners);
}

async function runSchedulerTick() {
    let due = [];
    try {
        const sources = await getActiveSources();
        const nowMs = Date.now();
        due = sources.filter((s) => isDue(s, nowMs));
    } catch (err) {
        logger.error({ err: err.message }, "scheduler: could not load sources");
        return;
    }
    if (!due.length) return;

    let changedCount = 0;
    await runWithConcurrency(due, config.maxConcurrency, async (s) => {
        const result = await checkOneSourceById(s.id);
        if (result.ok && result.changed) {
            changedCount++;
            logger.info({ id: s.id, name: s.name, new_items: result.new_items_count }, "CHANGED");
        }
    });

    // Tell connected browsers to refresh their source list.
    sse.broadcast("sources-changed", { at: new Date().toISOString(), checked: due.length, changed: changedCount });
}

function startScheduler() {
    let stopped = false;
    let timer = null;

    const loop = async () => {
        if (stopped) return;
        await runSchedulerTick();
        if (stopped) return;
        // Tick cadence + small jitter to avoid hammering every site on the same beat.
        const jitter = Math.floor(Math.random() * 2000);
        timer = setTimeout(loop, config.schedulerTickMs + jitter);
    };

    loop();
    logger.info({ tickMs: config.schedulerTickMs, concurrency: config.maxConcurrency }, "scheduler started");

    return function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}

module.exports = {
    startScheduler,
    runSchedulerTick,
    // exported for tests:
    baseIntervalMs,
    effectiveIntervalMs,
    isDue,
};
