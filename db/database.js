const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "app.db");
const db = new sqlite3.Database(dbPath);

// Columns we allow to be updated dynamically (guards against SQL injection
// via the generic updateSource()).
const UPDATABLE_COLUMNS = new Set([
    "name", "url", "is_active", "last_hash", "last_checked_at", "last_detected_at",
    "last_changed_at", "last_notified_at", "etag", "last_modified", "last_error",
    "consecutive_failures", "last_status", "check_interval_sec", "feed_url",
    "selector", "render_mode", "extract_mode", "next_retry_at",
]);

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

// ---------- Schema + migrations ----------
async function ensureColumn(table, column, definition) {
    const cols = await all(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) {
        await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

async function migrate() {
    await run(`
        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            url TEXT,
            is_active INTEGER DEFAULT 1,
            last_hash TEXT,
            last_checked_at TEXT,
            last_detected_at TEXT,
            last_changed_at TEXT,
            last_notified_at TEXT
        )
    `);

    await ensureColumn("sources", "etag", "TEXT");
    await ensureColumn("sources", "last_modified", "TEXT");
    await ensureColumn("sources", "last_error", "TEXT");
    await ensureColumn("sources", "consecutive_failures", "INTEGER DEFAULT 0");
    await ensureColumn("sources", "last_status", "TEXT");
    await ensureColumn("sources", "check_interval_sec", "INTEGER");
    await ensureColumn("sources", "feed_url", "TEXT");
    await ensureColumn("sources", "selector", "TEXT");
    await ensureColumn("sources", "render_mode", "TEXT DEFAULT 'static'");
    // 'auto' = feed/article-link detection; 'ticker' = watch the page itself and
    // capture short live-blog headline posts.
    await ensureColumn("sources", "extract_mode", "TEXT DEFAULT 'auto'");
    await ensureColumn("sources", "next_retry_at", "TEXT");
    await ensureColumn("sources", "created_at", "TEXT");

    await run(`
        CREATE TABLE IF NOT EXISTS seen_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            title TEXT,
            url TEXT,
            published_at TEXT,
            first_seen_at TEXT NOT NULL,
            UNIQUE(source_id, item_id)
        )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_seen_source ON seen_items(source_id)");
    await run("CREATE INDEX IF NOT EXISTS idx_seen_source_seen ON seen_items(source_id, first_seen_at DESC)");

    await run(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            subscription TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);
}

// ---------- Sources ----------
function getAllSources() {
    return all("SELECT * FROM sources ORDER BY id");
}

function getActiveSources() {
    return all("SELECT * FROM sources WHERE is_active = 1");
}

function getSourceById(id) {
    return get("SELECT * FROM sources WHERE id = ?", [id]);
}

async function addSource(fields) {
    const {
        name, url, feed_url = null, selector = null,
        render_mode = "static", extract_mode = "auto", check_interval_sec = null,
    } = fields;
    const res = await run(
        `INSERT INTO sources (name, url, feed_url, selector, render_mode, extract_mode, check_interval_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, url, feed_url, selector, render_mode, extract_mode, check_interval_sec, new Date().toISOString()]
    );
    return getSourceById(res.lastID);
}

async function toggleSource(id, isActive) {
    const res = await run("UPDATE sources SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, id]);
    return { id, is_active: isActive ? 1 : 0, found: res.changes > 0 };
}

async function deleteSource(id) {
    await run("DELETE FROM seen_items WHERE source_id = ?", [id]);
    const res = await run("DELETE FROM sources WHERE id = ?", [id]);
    return { id, found: res.changes > 0 };
}

async function deleteAllSources() {
    await run("DELETE FROM seen_items");
    const res = await run("DELETE FROM sources");
    return { deleted: res.changes };
}

// Generic, column-allowlisted update.
async function updateSource(id, fields = {}) {
    const keys = Object.keys(fields).filter((k) => UPDATABLE_COLUMNS.has(k));
    if (!keys.length) return { changes: 0 };
    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    const params = keys.map((k) => fields[k]);
    params.push(id);
    return run(`UPDATE sources SET ${setClause} WHERE id = ?`, params);
}

function updateLastNotified(id, timestamp) {
    return run("UPDATE sources SET last_notified_at = ? WHERE id = ?", [timestamp, id]);
}

// ---------- Seen items ----------
async function getSeenItemIds(sourceId) {
    const rows = await all("SELECT item_id FROM seen_items WHERE source_id = ?", [sourceId]);
    return rows.map((r) => r.item_id);
}

function getHistory(sourceId, limit = 50) {
    return all(
        "SELECT item_id, title, url, published_at, first_seen_at FROM seen_items WHERE source_id = ? ORDER BY first_seen_at DESC, id DESC LIMIT ?",
        [sourceId, limit]
    );
}

// Bulk insert in a single transaction.
function addSeenItems(sourceId, items, firstSeenAt) {
    if (!items.length) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run("BEGIN");
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO seen_items
                 (source_id, item_id, title, url, published_at, first_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            let inserted = 0;
            for (const item of items) {
                stmt.run(
                    [sourceId, item.item_id, item.title || null, item.url || null, item.published_at || null, firstSeenAt],
                    function (err) {
                        if (!err) inserted += this.changes || 0;
                    }
                );
            }
            stmt.finalize();
            db.run("COMMIT", (err) => (err ? reject(err) : resolve(inserted)));
        });
    });
}

// Keep only the newest `keep` items per source.
async function pruneSeenItems(sourceId, keep) {
    await run(
        `DELETE FROM seen_items
         WHERE source_id = ?
           AND id NOT IN (
               SELECT id FROM seen_items WHERE source_id = ?
               ORDER BY first_seen_at DESC, id DESC LIMIT ?
           )`,
        [sourceId, sourceId, keep]
    );
}

// ---------- Push subscriptions ----------
async function addPushSubscription(subscription) {
    await run(
        "INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?)",
        [subscription.endpoint, JSON.stringify(subscription), new Date().toISOString()]
    );
}

async function getPushSubscriptions() {
    const rows = await all("SELECT subscription FROM push_subscriptions");
    return rows.map((r) => {
        try {
            return JSON.parse(r.subscription);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

function removePushSubscription(endpoint) {
    return run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

module.exports = {
    db,
    migrate,
    getAllSources,
    getActiveSources,
    getSourceById,
    addSource,
    toggleSource,
    deleteSource,
    deleteAllSources,
    updateSource,
    updateLastNotified,
    getSeenItemIds,
    getHistory,
    addSeenItems,
    pruneSeenItems,
    addPushSubscription,
    getPushSubscriptions,
    removePushSubscription,
};
