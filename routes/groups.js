const express = require("express");
const { z } = require("zod");
const router = express.Router();

const logger = require("../lib/logger");
const sse = require("../services/sse");
const {
    getSourceById,
    userCanSeeSource,
    listWatchGroups,
    createWatchGroup,
    updateWatchGroup,
    deleteWatchGroup,
    assignSourceToGroup,
} = require("../db/database");

const nameSchema = z.object({ name: z.string().trim().min(1, "namn krävs").max(60) });
const updateSchema = z
    .object({
        name: z.string().trim().min(1).max(60).optional(),
        notify: z.boolean().optional(),
    })
    .refine((d) => d.name !== undefined || d.notify !== undefined, { message: "inget att uppdatera" });
const assignSchema = z.object({ groupId: z.number().int().positive().nullable() });

function parseId(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
        res.status(400).json({ error: "Ogiltigt id" });
        return null;
    }
    return id;
}

function validationError(res, err) {
    return res.status(400).json({ error: "Valideringsfel", details: err.issues?.map((i) => i.message) || [String(err)] });
}

// Bevakningar are personal; everything here is scoped to req.owner.
router.get("/groups", async (req, res) => {
    try {
        res.json(await listWatchGroups(req.owner));
    } catch (err) {
        logger.error({ err: err.message }, "list groups failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

router.post("/groups", async (req, res) => {
    if (!req.owner) return res.status(400).json({ error: "Logga in för att skapa mappar" });
    let data;
    try {
        data = nameSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        const group = await createWatchGroup(req.owner, data.name);
        res.status(201).json(group);
    } catch (err) {
        logger.error({ err: err.message }, "create group failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

router.patch("/groups/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    let data;
    try {
        data = updateSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        const result = await updateWatchGroup(req.owner, id, data);
        if (!result.changes) return res.status(404).json({ error: "Hittades inte" });
        if (data.notify !== undefined) {
            // Mute/unmute changes which larm reach this person, so nudge their
            // feed to re-sync.
            sse.broadcast("sources-changed", { at: new Date().toISOString() });
        }
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err: err.message }, "update group failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

router.delete("/groups/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
        const result = await deleteWatchGroup(req.owner, id);
        if (!result.found) return res.status(404).json({ error: "Hittades inte" });
        sse.broadcast("sources-changed", { at: new Date().toISOString() });
        res.json(result);
    } catch (err) {
        logger.error({ err: err.message }, "delete group failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

// Move a source into one of the caller's bevakningar (or out of any, groupId
// null). The source must be visible to the caller.
router.put("/sources/:id/group", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    let data;
    try {
        data = assignSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    if (!req.owner) return res.status(400).json({ error: "Logga in för att gruppera källor" });
    try {
        const source = await getSourceById(id);
        if (!source || !userCanSeeSource(source, req.owner)) {
            return res.status(404).json({ error: "Hittades inte" });
        }
        const ok = await assignSourceToGroup(req.owner, id, data.groupId);
        if (!ok) return res.status(404).json({ error: "Mappen hittades inte" });
        sse.broadcast("sources-changed", { at: new Date().toISOString() });
        res.json({ ok: true });
    } catch (err) {
        logger.error({ err: err.message }, "assign source group failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

module.exports = router;
