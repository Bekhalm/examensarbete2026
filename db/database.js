const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { PERMANENT_SOURCE_URLS } = require("../lib/permanentSources");

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
    // Core sources that must never be removed (trash button hidden, delete blocked).
    await ensureColumn("sources", "is_permanent", "INTEGER DEFAULT 0");
    // Owner = canonical username of the person who added a personal source.
    // NULL = shared (core/permanent sources, and any legacy pre-login sources).
    await ensureColumn("sources", "owner", "TEXT");
    await syncPermanentSources();

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
    // Which person a push subscription belongs to, so personal-source alerts only
    // reach their owner. NULL = legacy/shared subscription (gets shared alerts).
    await ensureColumn("push_subscriptions", "owner", "TEXT");

    // Lightweight user registry: maps a canonical username to its display form.
    // There are no per-user passwords — everyone shares one access password — so
    // this is just a label store for attribution and the "logged in as" UI.
    await run(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_login_at TEXT
        )
    `);

    // Per-person "bevakningar": a reporter groups their sources however they like
    // and flips notifications on/off per group (notify = 0 fully mutes that group
    // for that person only — core sources stay shared, the grouping is personal).
    await run(`
        CREATE TABLE IF NOT EXISTS watch_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            notify INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
    `);
    // Which group a source sits in, per person. One group per source per person.
    // A core/shared source can be filed differently by each reporter, so the key
    // is (owner, source_id) — not the source alone.
    await run(`
        CREATE TABLE IF NOT EXISTS watch_assignments (
            owner TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            group_id INTEGER NOT NULL,
            PRIMARY KEY (owner, source_id)
        )
    `);
    await run("CREATE INDEX IF NOT EXISTS idx_watch_assign_owner ON watch_assignments(owner)");
    await run("CREATE INDEX IF NOT EXISTS idx_watch_assign_group ON watch_assignments(group_id)");
}

// The URL list is authoritative: flag listed sources as permanent and clear the
// flag from any that are no longer listed, so editing the list takes effect on
// the next startup.
async function syncPermanentSources() {
    await run("UPDATE sources SET is_permanent = 0 WHERE is_permanent = 1");
    if (!PERMANENT_SOURCE_URLS.length) return;
    const placeholders = PERMANENT_SOURCE_URLS.map(() => "?").join(", ");
    await run(`UPDATE sources SET is_permanent = 1 WHERE url IN (${placeholders})`, PERMANENT_SOURCE_URLS);
}

// ---------- Sources ----------
function getAllSources() {
    return all("SELECT * FROM sources ORDER BY id");
}

// What a given user sees: shared sources (owner IS NULL — core/permanent and any
// legacy pre-login sources) plus their own personal additions. A null owner
// (auth disabled) means a single shared space, so everything is visible.
function getSourcesForUser(owner) {
    if (!owner) return getAllSources();
    // LEFT JOIN the caller's own group assignment so each source carries the
    // group_id this person filed it under (NULL = ungrouped, for them).
    return all(
        `SELECT s.*, a.group_id AS group_id
         FROM sources s
         LEFT JOIN watch_assignments a ON a.source_id = s.id AND a.owner = ?
         WHERE s.owner IS NULL OR s.owner = ?
         ORDER BY s.id`,
        [owner, owner]
    );
}

function getActiveSources() {
    return all("SELECT * FROM sources WHERE is_active = 1");
}

function getSourceById(id) {
    return get("SELECT * FROM sources WHERE id = ?", [id]);
}

// Can this user see/manage this source? Shared sources (owner NULL) are visible
// to everyone; personal sources only to their owner.
function userCanSeeSource(source, owner) {
    if (!source) return false;
    if (!owner) return true; // auth disabled → single shared space
    return source.owner == null || source.owner === owner;
}

// Core/permanent sources are locked for everyone. Otherwise a user may only
// manage their own personal sources, plus legacy shared (owner NULL) ones.
function userCanModifySource(source, owner) {
    if (!source || source.is_permanent) return false;
    if (!owner) return true;
    return source.owner == null || source.owner === owner;
}

async function addSource(fields) {
    const {
        name, url, feed_url = null, selector = null,
        render_mode = "static", extract_mode = "auto", check_interval_sec = null,
        owner = null,
    } = fields;
    const res = await run(
        `INSERT INTO sources (name, url, feed_url, selector, render_mode, extract_mode, check_interval_sec, owner, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, url, feed_url, selector, render_mode, extract_mode, check_interval_sec, owner, new Date().toISOString()]
    );
    return getSourceById(res.lastID);
}

async function toggleSource(id, isActive) {
    const res = await run("UPDATE sources SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, id]);
    return { id, is_active: isActive ? 1 : 0, found: res.changes > 0 };
}

// Core/permanent sources can never be removed; everything else is fair game.
async function deleteSource(id) {
    const row = await get("SELECT is_permanent FROM sources WHERE id = ?", [id]);
    if (!row) return { id, found: false };
    if (row.is_permanent) return { id, found: true, blocked: true };
    await run("DELETE FROM seen_items WHERE source_id = ?", [id]);
    const res = await run("DELETE FROM sources WHERE id = ?", [id]);
    return { id, found: res.changes > 0 };
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
async function addPushSubscription(subscription, owner = null) {
    await run(
        "INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription, owner, created_at) VALUES (?, ?, ?, ?)",
        [subscription.endpoint, JSON.stringify(subscription), owner, new Date().toISOString()]
    );
}

function parseSubs(rows) {
    return rows.map((r) => {
        try {
            return JSON.parse(r.subscription);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

// All subscriptions — used for shared (core) source alerts.
async function getPushSubscriptions() {
    return parseSubs(await all("SELECT subscription FROM push_subscriptions"));
}

// Only a given person's subscriptions — used for their personal-source alerts.
async function getPushSubscriptionsForOwner(owner) {
    if (!owner) return getPushSubscriptions();
    return parseSubs(await all("SELECT subscription FROM push_subscriptions WHERE owner = ?", [owner]));
}

function removePushSubscription(endpoint) {
    return run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

// ---------- Users (label registry, no per-user passwords) ----------
async function upsertUser(canonical, display) {
    const now = new Date().toISOString();
    await run(
        `INSERT INTO users (username, display_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, last_login_at = excluded.last_login_at`,
        [canonical, display, now, now]
    );
}

async function getUserDisplay(canonical) {
    if (!canonical) return null;
    const row = await get("SELECT display_name FROM users WHERE username = ?", [canonical]);
    return row ? row.display_name : null;
}

// ---------- Watch groups (bevakningar) ----------
// Every group helper is owner-scoped: a person can only see and touch their own
// bevakningar. With auth disabled (owner null) there are no groups.
function listWatchGroups(owner) {
    if (!owner) return Promise.resolve([]);
    return all(
        `SELECT g.id, g.name, g.notify, g.created_at,
                (SELECT COUNT(*) FROM watch_assignments a WHERE a.group_id = g.id AND a.owner = g.owner) AS member_count
         FROM watch_groups g
         WHERE g.owner = ?
         ORDER BY g.created_at, g.id`,
        [owner]
    );
}

async function createWatchGroup(owner, name) {
    const res = await run(
        "INSERT INTO watch_groups (owner, name, notify, created_at) VALUES (?, ?, 1, ?)",
        [owner, name, new Date().toISOString()]
    );
    return get("SELECT id, name, notify, created_at FROM watch_groups WHERE id = ?", [res.lastID]);
}

async function updateWatchGroup(owner, id, fields = {}) {
    const sets = [];
    const params = [];
    if (typeof fields.name === "string") {
        sets.push("name = ?");
        params.push(fields.name);
    }
    if (fields.notify !== undefined) {
        sets.push("notify = ?");
        params.push(fields.notify ? 1 : 0);
    }
    if (!sets.length) return { changes: 0 };
    params.push(id, owner);
    return run(`UPDATE watch_groups SET ${sets.join(", ")} WHERE id = ? AND owner = ?`, params);
}

// Deleting a map also deletes the sources filed into it — but only the caller's
// own, non-permanent sources. Protected core sources (and any shared ones) are
// left intact and simply un-filed, since they belong to everyone.
async function deleteWatchGroup(owner, id) {
    const rows = await all("SELECT source_id FROM watch_assignments WHERE group_id = ? AND owner = ?", [id, owner]);
    let deletedSources = 0;
    let keptProtected = 0;
    for (const { source_id } of rows) {
        const src = await get("SELECT id, owner, is_permanent FROM sources WHERE id = ?", [source_id]);
        if (src && !src.is_permanent && src.owner != null && src.owner === owner) {
            await run("DELETE FROM seen_items WHERE source_id = ?", [source_id]);
            await run("DELETE FROM sources WHERE id = ?", [source_id]);
            deletedSources++;
        } else if (src) {
            keptProtected++;
        }
    }
    await run("DELETE FROM watch_assignments WHERE group_id = ? AND owner = ?", [id, owner]);
    const res = await run("DELETE FROM watch_groups WHERE id = ? AND owner = ?", [id, owner]);
    return { id, found: res.changes > 0, deletedSources, keptProtected };
}

// Move a source into one of the caller's groups, or out of any group (null).
// Returns false if the target group doesn't belong to the caller.
async function assignSourceToGroup(owner, sourceId, groupId) {
    if (!groupId) {
        await run("DELETE FROM watch_assignments WHERE owner = ? AND source_id = ?", [owner, sourceId]);
        return true;
    }
    const grp = await get("SELECT id FROM watch_groups WHERE id = ? AND owner = ?", [groupId, owner]);
    if (!grp) return false;
    await run(
        "INSERT OR REPLACE INTO watch_assignments (owner, source_id, group_id) VALUES (?, ?, ?)",
        [owner, sourceId, groupId]
    );
    return true;
}

// Source ids the caller has filed into a muted (notify = 0) group. These are
// fully hidden from that person: no live alert, no backfill, no feed entry.
async function getMutedSourceIdsForOwner(owner) {
    if (!owner) return new Set();
    const rows = await all(
        `SELECT a.source_id
         FROM watch_assignments a
         JOIN watch_groups g ON g.id = a.group_id
         WHERE a.owner = ? AND g.notify = 0`,
        [owner]
    );
    return new Set(rows.map((r) => r.source_id));
}

module.exports = {
    db,
    migrate,
    getAllSources,
    getSourcesForUser,
    getActiveSources,
    getSourceById,
    userCanSeeSource,
    userCanModifySource,
    addSource,
    toggleSource,
    deleteSource,
    updateSource,
    updateLastNotified,
    getSeenItemIds,
    getHistory,
    addSeenItems,
    pruneSeenItems,
    addPushSubscription,
    getPushSubscriptions,
    getPushSubscriptionsForOwner,
    removePushSubscription,
    upsertUser,
    getUserDisplay,
    listWatchGroups,
    createWatchGroup,
    updateWatchGroup,
    deleteWatchGroup,
    assignSourceToGroup,
    getMutedSourceIdsForOwner,
};
