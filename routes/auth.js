const express = require("express");
const { z } = require("zod");
const router = express.Router();

const config = require("../lib/config");
const logger = require("../lib/logger");
const auth = require("../lib/auth");
const { upsertUser, getUserDisplay } = require("../db/database");

const loginSchema = z.object({
    username: z.string().min(1).max(60),
    password: z.string().min(1).max(200),
});

// Who am I? The frontend calls this on load to decide whether to show the login
// screen. Always public.
router.get("/me", async (req, res) => {
    if (!config.authEnabled) {
        return res.json({ authEnabled: false, username: null });
    }
    const display = req.owner ? await getUserDisplay(req.owner) : null;
    res.json({ authEnabled: true, username: display });
});

router.post("/login", async (req, res) => {
    if (!config.authEnabled) return res.json({ ok: true, username: null });

    let data;
    try {
        data = loginSchema.parse(req.body);
    } catch {
        return res.status(400).json({ error: "Ange användarnamn och lösenord" });
    }

    const { display, canonical } = auth.normalizeUsername(data.username);
    if (!auth.isValidUsername(display)) {
        return res.status(400).json({ error: "Ogiltigt användarnamn (minst 2 tecken, bokstäver/siffror)" });
    }
    if (!auth.passwordMatches(data.password)) {
        return res.status(401).json({ error: "Fel lösenord" });
    }

    try {
        await upsertUser(canonical, display);
    } catch (err) {
        logger.warn({ err: err.message }, "user upsert failed");
    }
    auth.setSession(res, canonical, req);
    res.json({ ok: true, username: display });
});

router.post("/logout", (_req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
});

module.exports = router;
