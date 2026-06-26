// Minimal Server-Sent Events hub: keeps a set of open responses and
// broadcasts named events to the right browsers.
const { getMutedSourceIdsForOwner } = require("../db/database");

const clients = new Set(); // { res, owner }

// Recent alerts kept in memory so a browser that (re)connects can catch up on
// larm it missed while its live stream was briefly disconnected. Each alert
// carries an `owner` (null = shared/core source, visible to everyone).
const recentAlerts = []; // oldest first
const MAX_RECENT = 200;

function recordAlert(payload) {
    recentAlerts.push(payload);
    if (recentAlerts.length > MAX_RECENT) recentAlerts.shift();
}

// A shared alert (owner null) reaches everyone; a personal alert only reaches
// its owner. A null viewer (auth disabled) sees everything.
function visibleTo(payload, owner) {
    if (payload.owner == null) return true;
    if (owner == null) return true;
    return payload.owner === owner;
}

function alertsForOwner(owner) {
    return recentAlerts.filter((p) => visibleTo(p, owner));
}

function handler(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const client = { res, owner: req.owner || null };
    clients.add(client);

    // Catch this client up on the larm it's allowed to see (minus anything in a
    // muted bevakning), so the Larmflöde isn't empty after a reconnect.
    getMutedSourceIdsForOwner(client.owner)
        .then((muted) => {
            const backfill = alertsForOwner(client.owner).filter((p) => !muted.has(p.id));
            if (backfill.length) write(client, "backfill", backfill);
        })
        .catch(() => {
            const backfill = alertsForOwner(client.owner);
            if (backfill.length) write(client, "backfill", backfill);
        });

    const keepAlive = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* ignore */
        }
    }, 25_000);

    req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(client);
    });
}

function write(client, event, data) {
    try {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
        clients.delete(client);
    }
}

// Generic broadcast to everyone (used for non-sensitive UI signals like
// "sources-changed").
function broadcast(event, data) {
    for (const client of clients) write(client, event, data);
}

// Deliver an alert only to the browsers allowed to see it — and never to a
// person who has filed this source into a muted bevakning. We resolve the muted
// set once per distinct owner to avoid hammering the DB for shared sources.
function broadcastAlert(payload) {
    recordAlert(payload);
    deliverAlert(payload).catch(() => {});
}

async function deliverAlert(payload) {
    const byOwner = new Map();
    for (const client of clients) {
        if (!visibleTo(payload, client.owner)) continue;
        const key = client.owner || "";
        if (!byOwner.has(key)) byOwner.set(key, { owner: client.owner, list: [] });
        byOwner.get(key).list.push(client);
    }
    for (const { owner, list } of byOwner.values()) {
        let muted;
        try {
            muted = await getMutedSourceIdsForOwner(owner);
        } catch {
            muted = new Set();
        }
        if (muted.has(payload.id)) continue;
        for (const client of list) write(client, "alert", payload);
    }
}

// Recent alerts for a given viewer, minus anything in one of their muted
// bevakningar. Used by the polling fallback so the Larmflöde stays reliable
// even when the live stream is buffered by a proxy.
async function recentAlertsForOwner(owner) {
    const muted = await getMutedSourceIdsForOwner(owner || null);
    return alertsForOwner(owner || null).filter((p) => !muted.has(p.id));
}

module.exports = { handler, broadcast, broadcastAlert, recentAlertsForOwner };
