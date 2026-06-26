const express = require("express");
const fetch = require("node-fetch");
const { z } = require("zod");
const router = express.Router();

const config = require("../lib/config");
const logger = require("../lib/logger");
const { assertSafeUrl } = require("../lib/safeUrl");
const { discoverFeeds } = require("../services/feeds");
const notifier = require("../services/notifier");
const sse = require("../services/sse");
const {
    getSourcesForUser,
    getSourceById,
    userCanSeeSource,
    userCanModifySource,
    addSource,
    toggleSource,
    deleteSource,
    getHistory,
    addPushSubscription,
    removePushSubscription,
} = require("../db/database");

const { checkOneSourceById } = require("../services/changeDetector");
const { effectiveIntervalMs } = require("../scheduler/scheduler");

// Annotate a source with when its next automatic check is expected, so the UI
// can show a live "checked Xs ago · next in Ym" heartbeat.
function withTiming(s) {
    let nextCheckAt = null;
    if (s.is_active) {
        if (s.next_retry_at && Date.parse(s.next_retry_at) > Date.now()) {
            nextCheckAt = s.next_retry_at;
        } else if (!s.last_checked_at) {
            nextCheckAt = new Date().toISOString();
        } else {
            nextCheckAt = new Date(Date.parse(s.last_checked_at) + effectiveIntervalMs(s)).toISOString();
        }
    }
    return { ...s, next_check_at: nextCheckAt };
}

// ---------- validation ----------
const addSchema = z.object({
    name: z.string().trim().min(1, "namn krävs").max(120),
    url: z.string().trim().url("ogiltig URL"),
    selector: z.string().trim().max(200).optional(),
    render_mode: z.enum(["static", "js"]).optional(),
    extract_mode: z.enum(["auto", "ticker"]).optional(),
    check_interval_sec: z.number().int().min(config.minCheckIntervalSec).max(86400).optional(),
    discoverFeed: z.boolean().optional(),
});
const toggleSchema = z.object({ isActive: z.boolean() });
const discoverSchema = z.object({ url: z.string().trim().url() });
const subscribeSchema = z.object({
    subscription: z.object({ endpoint: z.string().url() }).passthrough(),
});
const unsubscribeSchema = z.object({ endpoint: z.string().url() });

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

// Live blogs / direkt-rapporter publish short headline posts on the page itself
// rather than via RSS, so watch the page directly when the URL looks like one.
// (Replaces the old manual "Live-ticker" checkbox.)
const TICKER_URL_SIGNALS = [
    "direkt",
    "direktrapport",
    "direktsand",
    "/live",
    "live-",
    "-live",
    "liveblog",
    "live-blog",
    "minut-for-minut",
    "minut-f\u00f6r-minut",
];
function autoDetectExtractMode(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const haystack = (u.pathname + u.search).toLowerCase();
        if (TICKER_URL_SIGNALS.some((s) => haystack.includes(s))) return "ticker";
    } catch {
        /* fall through to default */
    }
    return "auto";
}

// ---------- simple per-IP rate limiter for /check ----------
const hits = new Map();
function rateLimitCheck(req, res, next) {
    const ip = req.ip || "unknown";
    const nowMin = Math.floor(Date.now() / 60000);
    const key = `${ip}:${nowMin}`;
    const count = (hits.get(key) || 0) + 1;
    hits.set(key, count);
    if (hits.size > 5000) hits.clear(); // crude cleanup
    if (count > config.checkRateLimitPerMin) {
        return res.status(429).json({ error: "För många förfrågningar, försök igen om en stund" });
    }
    next();
}

// Recent alerts. Polled by the client as a reliable fallback when the live SSE
// stream is buffered by a proxy/tunnel.
router.get("/alerts", async (req, res) => {
    try {
        res.json(await sse.recentAlertsForOwner(req.owner));
    } catch (err) {
        logger.error({ err: err.message }, "list alerts failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

// ---------- sources ----------
router.get("/sources", async (req, res) => {
    try {
        const sources = await getSourcesForUser(req.owner);
        res.json(sources.map(withTiming));
    } catch (err) {
        logger.error({ err: err.message }, "list sources failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

router.get("/sources/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const source = await getSourceById(id);
    if (!source || !userCanSeeSource(source, req.owner)) {
        return res.status(404).json({ error: "Hittades inte" });
    }
    res.json(source);
});

router.get("/sources/:id/history", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
        const source = await getSourceById(id);
        if (!source || !userCanSeeSource(source, req.owner)) {
            return res.status(404).json({ error: "Hittades inte" });
        }
        res.json(await getHistory(id, 50));
    } catch (err) {
        res.status(500).json({ error: "Databasfel" });
    }
});

// Normalise a URL for duplicate detection: ignore protocol, a leading "www.",
// and a trailing slash, but keep the path + query (some sources differ only by
// query, e.g. the Polisen feed).
function normalizeForCompare(raw) {
    try {
        const u = new URL(raw);
        const host = u.hostname.toLowerCase().replace(/^www\./, "");
        const path = u.pathname.replace(/\/+$/, "") || "/";
        return host + path + u.search;
    } catch {
        return String(raw || "").trim().toLowerCase();
    }
}

router.post("/sources", async (req, res) => {
    let data;
    try {
        data = addSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }

    try {
        await assertSafeUrl(data.url);
    } catch (err) {
        return res.status(400).json({ error: err.message || "Otillåten URL" });
    }

    // Warn instead of silently creating a duplicate of a source already visible
    // to this user (their own + the shared core list).
    try {
        const norm = normalizeForCompare(data.url);
        const existing = await getSourcesForUser(req.owner);
        const dup = existing.find((s) => normalizeForCompare(s.url) === norm);
        if (dup) {
            return res.status(409).json({ error: `Källan finns redan i listan: "${dup.name}"` });
        }
    } catch (err) {
        logger.debug({ err: err.message }, "duplicate check failed");
    }

    // Optional feed auto-discovery (best-effort, non-blocking on failure).
    // Ticker mode deliberately watches the exact page, so never auto-discover a
    // site-wide feed for it (that's what turned a live page into a duplicate).
    const extractMode = data.extract_mode || autoDetectExtractMode(data.url);
    const isTicker = extractMode === "ticker";
    let feedUrl = null;
    if (data.discoverFeed !== false && !isTicker) {
        try {
            const feeds = await discoverFeeds(data.url);
            const best = feeds.find((f) => f.verified || f.self) || feeds[0];
            if (best && (best.score === undefined || best.score > 0 || best.self)) feedUrl = best.url;
        } catch (err) {
            logger.debug({ err: err.message }, "feed discovery failed");
        }
    }

    try {
        const source = await addSource({
            name: data.name,
            url: data.url,
            feed_url: feedUrl,
            selector: data.selector || null,
            render_mode: data.render_mode || "static",
            extract_mode: extractMode,
            check_interval_sec: data.check_interval_sec || null,
            owner: req.owner,
        });
        sse.broadcast("sources-changed", { at: new Date().toISOString() });
        res.status(201).json(source);
    } catch (err) {
        logger.error({ err: err.message }, "add source failed");
        res.status(500).json({ error: "Databasfel" });
    }
});

router.post("/sources/discover", async (req, res) => {
    let data;
    try {
        data = discoverSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        res.json({ feeds: await discoverFeeds(data.url) });
    } catch (err) {
        res.status(502).json({ error: "Kunde inte hämta sidan", details: err.message });
    }
});

router.post("/sources/:id/toggle", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    let data;
    try {
        data = toggleSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        const existing = await getSourceById(id);
        if (!existing || !userCanSeeSource(existing, req.owner)) {
            return res.status(404).json({ error: "Hittades inte" });
        }
        if (!userCanModifySource(existing, req.owner)) {
            return res.status(403).json({ error: "Kärnkälla – kan inte ändras" });
        }
        const result = await toggleSource(id, data.isActive);
        if (!result.found) return res.status(404).json({ error: "Hittades inte" });
        sse.broadcast("sources-changed", { at: new Date().toISOString() });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: "Databasfel" });
    }
});

router.delete("/sources/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
        const existing = await getSourceById(id);
        if (!existing || !userCanSeeSource(existing, req.owner)) {
            return res.status(404).json({ error: "Hittades inte" });
        }
        if (existing.is_permanent) return res.status(403).json({ error: "Kärnkälla – kan inte tas bort" });
        if (!userCanModifySource(existing, req.owner)) {
            return res.status(403).json({ error: "Du kan bara ta bort dina egna källor" });
        }
        const result = await deleteSource(id);
        if (!result.found) return res.status(404).json({ error: "Hittades inte" });
        if (result.blocked) return res.status(403).json({ error: "Kärnkälla – kan inte tas bort" });
        sse.broadcast("sources-changed", { at: new Date().toISOString() });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: "Databasfel" });
    }
});

router.post("/sources/:id/check", rateLimitCheck, async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
        const existing = await getSourceById(id);
        if (!existing || !userCanSeeSource(existing, req.owner)) {
            return res.status(404).json({ error: "Hittades inte" });
        }
        const result = await checkOneSourceById(id);
        if (!result.ok) {
            if (result.reason === "not_found") return res.status(404).json({ error: "Hittades inte" });
            if (result.reason === "inactive") return res.status(400).json({ error: "Källan är pausad" });
            if (result.reason === "fetch_error") {
                return res.status(502).json({ error: "Hämtning misslyckades", details: result.error_message });
            }
            return res.status(400).json({ error: "Kontroll misslyckades" });
        }
        res.json(result);
    } catch (err) {
        logger.error({ err: err.message }, "check failed");
        res.status(500).json({ error: "Kontroll misslyckades" });
    }
});

// ---------- favicon proxy (keeps the journalist's browsing private) ----------
router.get("/favicon", async (req, res) => {
    const domain = String(req.query.domain || "").replace(/[^a-z0-9.\-:]/gi, "");
    if (!domain) return res.status(400).end();
    try {
        const r = await fetch(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`, {
            headers: { "user-agent": config.userAgent },
        });
        if (!r.ok) return res.status(404).end();
        res.set("Content-Type", r.headers.get("content-type") || "image/x-icon");
        res.set("Cache-Control", "public, max-age=86400");
        const buf = Buffer.from(await r.arrayBuffer());
        res.end(buf);
    } catch {
        res.status(404).end();
    }
});

// ---------- web push ----------
router.get("/push/key", (_req, res) => {
    res.json({ enabled: notifier.pushEnabled(), publicKey: config.vapid.publicKey || null });
});

router.post("/push/subscribe", async (req, res) => {
    let data;
    try {
        data = subscribeSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        await addPushSubscription(data.subscription, req.owner);
        res.status(201).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Kunde inte spara prenumeration" });
    }
});

router.post("/push/unsubscribe", async (req, res) => {
    let data;
    try {
        data = unsubscribeSchema.parse(req.body);
    } catch (err) {
        return validationError(res, err);
    }
    try {
        await removePushSubscription(data.endpoint);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Kunde inte avregistrera prenumeration" });
    }
});

// ---------- live stream (SSE) ----------
router.get("/stream", sse.handler);

module.exports = router;
