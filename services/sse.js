// Minimal Server-Sent Events hub: keeps a set of open responses and
// broadcasts named events to all connected browsers.
const clients = new Set();

function handler(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    clients.add(res);

    const keepAlive = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* ignore */
        }
    }, 25_000);

    req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
    });
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try {
            res.write(payload);
        } catch {
            clients.delete(res);
        }
    }
}

function clientCount() {
    return clients.size;
}

module.exports = { handler, broadcast, clientCount };
