const fs = require("fs");
const path = require("path");

const LOCK_PATH = path.join(__dirname, "..", ".server.lock");

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0); // signal 0 = existence check, doesn't kill
        return true;
    } catch (err) {
        return err.code === "EPERM"; // exists but owned by another user
    }
}

// Ensures only one server instance runs at a time. Throws if another live
// instance already holds the lock (prevents the "zombie second server
// corrupting the database" problem). Returns a release() function.
function acquireLock() {
    if (fs.existsSync(LOCK_PATH)) {
        const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
            const e = new Error(
                `En annan server körs redan (PID ${pid}). Stäng den först, eller kör: kill ${pid}`
            );
            e.code = "already_running";
            e.pid = pid;
            throw e;
        }
        // Stale lock from a crashed process — safe to take over.
    }

    fs.writeFileSync(LOCK_PATH, String(process.pid), "utf8");

    let released = false;
    return function release() {
        if (released) return;
        released = true;
        try {
            const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
            if (Number(raw) === process.pid) fs.unlinkSync(LOCK_PATH);
        } catch {
            /* already gone */
        }
    };
}

module.exports = { acquireLock, LOCK_PATH };
