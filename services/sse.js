// Minimal Server-Sent Events hub: keeps a set of open responses and
// broadcasts named events to every connected browser.
const clients = new Set(); // { res }

// Recent alerts kept in memory so a browser that (re)connects can catch up on
// larm it missed while its live stream was briefly disconnected (common over a
// flaky tunnel). Push banners are delivered server-side regardless, so this
// keeps the in-app Larmflöde consistent with the banners people receive.
const recentAlerts = []; // oldest first
const MAX_RECENT = 100;

function recordAlert(payload) {
    recentAlerts.push(payload);
    if (recentAlerts.length > MAX_RECENT) recentAlerts.shift();
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

    const client = { res };
    clients.add(client);

    // Catch this client up on recent larm, so the Larmflöde isn't empty after a
    // reconnect. Sent as a separate "backfill" event the client adds silently.
    if (recentAlerts.length) write(client, "backfill", recentAlerts.slice());

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

// Generic broadcast to everyone (used for non-sensitive UI signals).
function broadcast(event, data) {
    for (const client of clients) write(client, event, data);
}

// Deliver an alert to every connected browser.
function broadcastAlert(payload) {
    recordAlert(payload);
    for (const client of clients) write(client, "alert", payload);
}

// Recent alerts. Used by the polling fallback so the Larmflöde stays reliable
// even when the live stream is buffered by a proxy/tunnel.
function recentAlertsAll() {
    return recentAlerts.slice();
}

module.exports = { handler, broadcast, broadcastAlert, recentAlertsAll };
