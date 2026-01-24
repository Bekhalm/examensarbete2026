const { getAllSources } = require("../db/database");
const { checkOneSourceById } = require("../services/changeDetector");

async function runSchedulerTick() {
    try {
        const sources = await getAllSources();
        const active = sources.filter((s) => s.is_active === 1);

        for (const s of active) {
            const result = await checkOneSourceById(s.id);
            if (result.ok && result.changed) {
                console.log("CHANGE DETECTED:", s.name, s.url, result.last_changed_at);
            }
        }
    } catch (err) {
        console.error("Scheduler error:", err);
    }
}

function startScheduler(intervalMs = 30_000) {
    // kör en gång direkt
    runSchedulerTick();
    // sen loop
    setInterval(runSchedulerTick, intervalMs);
}

module.exports = { startScheduler };
