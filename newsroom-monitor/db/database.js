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
      is_active INTEGER DEFAULT 1
    )
  `);
});

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
                else resolve({ id, is_active: isActive ? 1 : 0 });
            }
        );
    });
}



module.exports = {
    db,
    getAllSources,
    addSource,
    toggleSource,
};
