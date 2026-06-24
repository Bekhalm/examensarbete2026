// Minimal Server-Sent Events hub: keeps a set of open responses and
// broadcasts named events to connected browsers. Each connection carries the
// viewer's "space" so personal alerts only reach their owner.
const { normalizeSpace } = require("../lib/space");

const clients = new Set(); // { res, space }

function handler(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const client = { res, space: normalizeSpace(req.query.space) };
    clients.add(client);

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

// Scoped alert: shared sources (owner null) reach everyone; a personal source
// only reaches connections whose space matches the owner.
function broadcastAlert(payload) {
    const owner = payload && payload.owner ? payload.owner : null;
    for (const client of clients) {
        if (owner === null || client.space === owner) write(client, "alert", payload);
    }
}

function clientCount() {
    return clients.size;
}

module.exports = { handler, broadcast, broadcastAlert, clientCount };
