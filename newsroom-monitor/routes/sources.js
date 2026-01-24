const express = require("express");
const router = express.Router();

const {
    getAllSources,
    addSource,
    toggleSource,
} = require("../db/database");

const { checkOneSourceById } = require("../services/changeDetector");

// GET /api/sources
router.get("/sources", async (req, res) => {
    try {
        const sources = await getAllSources();
        res.json(sources);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// POST /api/sources
router.post("/sources", async (req, res) => {
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

// POST /api/sources/:id/toggle
router.post("/sources/:id/toggle", async (req, res) => {
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

// POST /api/sources/:id/check
router.post("/sources/:id/check", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    try {
        const result = await checkOneSourceById(id);
        if (!result.ok) {
            if (result.reason === "not_found") return res.status(404).json({ error: "Not found" });
            if (result.reason === "inactive") return res.status(400).json({ error: "Source is inactive" });
            return res.status(400).json({ error: "Check failed" });
        }
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Check failed" });
    }
});

module.exports = router;
