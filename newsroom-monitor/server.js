const path = require("path");
const express = require("express");
const { getAllSources, addSource, toggleSource } = require("./db/database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Servera frontend 
app.use(express.static(path.join(__dirname, "public")));

// Root ska visa index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Koll
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Lista källor
app.get("/api/sources", async (req, res) => {
    try {
        const sources = await getAllSources();
        res.json(sources);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// Lägg till källa
app.post("/api/sources", async (req, res) => {
    const { name, url } = req.body;

    if (!name || !url) {
        return res.status(400).json({ error: "name and url are required" });
    }

    try {
        const source = await addSource(name, url);
        res.status(201).json(source);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// Toggle
app.post("/api/sources/:id/toggle", async (req, res) => {
    const id = Number(req.params.id);
    const { isActive } = req.body;

    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    if (typeof isActive !== "boolean") {
        return res.status(400).json({ error: "isActive must be boolean" });
    }

    try {
        const result = await toggleSource(id, isActive);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
