const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "app.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`
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

    db.all("PRAGMA table_info(sources)", (err, rows = []) => {
        if (err) return;
        const hasLastDetectedAt = rows.some((r) => r.name === "last_detected_at");
        if (!hasLastDetectedAt) {
            db.run("ALTER TABLE sources ADD COLUMN last_detected_at TEXT");
        }
    });

    db.run(`
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

});

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}


function getAllSources() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM sources", (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function addSource(name, url) {
    return new Promise((resolve, reject) => {
        const stmt = `
        INSERT INTO sources (name, url)
        VALUES (?, ?)
      `;
        db.run(stmt, [name, url], function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, name, url });
        });
    });
}

function toggleSource(id, isActive) {
    return new Promise((resolve, reject) => {
        db.run(
            "UPDATE sources SET is_active = ? WHERE id = ?",
            [isActive ? 1 : 0, id],
            function (err) {
                if (err) reject(err);
                else resolve({ id, is_active: isActive ? 1 : 0, found: this.changes > 0 });
            }
        );
    });
}

function getSourceById(id) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM sources WHERE id = ?", [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function updateSourceCheck(
    id,
    { last_hash, last_checked_at, last_detected_at, last_changed_at, update_last_changed = false }
) {
    return new Promise((resolve, reject) => {
        db.run(
            `
        UPDATE sources
        SET last_hash = ?,
            last_checked_at = ?,
            last_detected_at = COALESCE(?, last_detected_at),
            last_changed_at = CASE
                WHEN ? THEN ?
                ELSE last_changed_at
            END
        WHERE id = ?
        `,
            [
                last_hash,
                last_checked_at,
                last_detected_at,
                update_last_changed ? 1 : 0,
                last_changed_at || null,
                id,
            ],
            function (err) {
                if (err) reject(err);
                else resolve({ id, last_hash, last_checked_at, last_detected_at, last_changed_at });
            }
        );
    });
}

function updateLastNotified(id, timestamp) {
    return new Promise((resolve, reject) => {
        db.run(
            "UPDATE sources SET last_notified_at = ? WHERE id = ?",
            [timestamp, id],
            function (err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
}

function getSeenItemIds(sourceId) {
    return new Promise((resolve, reject) => {
        db.all(
            "SELECT item_id FROM seen_items WHERE source_id = ?",
            [sourceId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows.map((r) => r.item_id));
            }
        );
    });
}

async function addSeenItems(sourceId, items, firstSeenAt) {
    if (!items.length) return 0;
    let inserted = 0;

    for (const item of items) {
        const result = await runQuery(
            `
      INSERT OR IGNORE INTO seen_items
      (source_id, item_id, title, url, published_at, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
            [
                sourceId,
                item.item_id,
                item.title || null,
                item.url || null,
                item.published_at || null,
                firstSeenAt,
            ]
        );
        inserted += result.changes || 0;
    }

    return inserted;
}



module.exports = {
    db,
    getAllSources,
    addSource,
    toggleSource,
    getSourceById,
    updateSourceCheck,
    updateLastNotified,
    getSeenItemIds,
    addSeenItems
};
