const dns = require("dns").promises;
const net = require("net");
const config = require("./config");

// Returns true if an IP literal is in a private / loopback / link-local /
// reserved range that should never be fetched server-side (SSRF protection).
function isPrivateIp(ip) {
    const type = net.isIP(ip);
    if (type === 4) return isPrivateIpv4(ip);
    if (type === 6) return isPrivateIpv6(ip);
    return true; // not a valid IP -> treat as unsafe
}

function isPrivateIpv4(ip) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
    if (a >= 224) return true; // multicast / reserved
    return false;
}

function isPrivateIpv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    return false;
}

function hostKey(url) {
    return `${url.hostname.replace(/^\[|\]$/g, "")}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
}

// Validates a user-supplied URL before the server fetches it.
// Throws an Error (with .code) when the URL is unsafe.
async function assertSafeUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        const e = new Error("Ogiltig URL");
        e.code = "invalid_url";
        throw e;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        const e = new Error("Endast http/https tillåts");
        e.code = "bad_protocol";
        throw e;
    }

    if (!config.blockPrivateNetwork) return url;

    // Allowlisted hosts (e.g. the app's own origin for the demo) bypass the check.
    const key = `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`;
    if (config.allowedHosts.has(key) || config.allowedHosts.has(url.host)) return url;

    // If the host is already an IP literal, check it directly.
    if (net.isIP(url.hostname)) {
        if (isPrivateIp(url.hostname)) {
            const e = new Error("Privata/interna adresser är inte tillåtna");
            e.code = "private_address";
            throw e;
        }
        return url;
    }

    // Resolve all A/AAAA records; reject if ANY is private (DNS-rebinding safe-ish).
    let addresses;
    try {
        addresses = await dns.lookup(url.hostname, { all: true });
    } catch {
        const e = new Error("Kunde inte slå upp värdnamnet");
        e.code = "dns_error";
        throw e;
    }
    if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
        const e = new Error("Privata/interna adresser är inte tillåtna");
        e.code = "private_address";
        throw e;
    }

    return url;
}

module.exports = { assertSafeUrl, isPrivateIp, hostKey };
