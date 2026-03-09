const { getAllSources } = require("../db/database");
const { checkOneSourceById } = require("../services/changeDetector");

async function runSchedulerTick() {
    try {
        const sources = await getAllSources();
        const active = sources.filter((s) => s.is_active === 1);

        for (const s of active) {
            try {
                const result = await checkOneSourceById(s.id);
                if (!result.ok) {
                    console.warn("CHECK_FAILED:", s.name, s.url, result.reason, result.error_message || "");
                    continue;
                }

                if (result.changed) {
                    console.log(
                        "CHANGED:",
                        s.name,
                        s.url,
                        result.last_changed_at,
                        `new_items=${result.new_items_count || 0}`,
                        result.latest_item_title ? `latest="${result.latest_item_title}"` : ""
                    );
                }

                if (result.notify) {
                    console.log("NOTIFY:", s.name, s.url, result.last_notified_at);
                }
            } catch (sourceErr) {
                console.error("Source check error:", s.name, s.url, sourceErr.message || sourceErr);
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
