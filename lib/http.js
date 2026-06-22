const fetch = require("node-fetch");
const config = require("./config");
const { assertSafeUrl } = require("./safeUrl");

// Retry-After can be "<seconds>" or an HTTP date. Returns ms or null.
function parseRetryAfter(value) {
    if (!value) return null;
    const secs = Number(value);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(value);
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    return null;
}

// Fetches a URL safely with conditional-GET support.
// Returns { status, notModified, body, contentType, etag, lastModified, finalUrl }.
// Throws on network errors / unsafe URLs / non-OK statuses (except 304).
//
// Redirects are followed MANUALLY so each hop is re-validated by assertSafeUrl.
// (With redirect:"follow", a public URL could 30x-redirect to an internal/
// metadata address and bypass the SSRF guard.)
async function fetchUrl(rawUrl, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || config.fetchTimeoutMs);

    const headers = {
        "user-agent": config.userAgent,
        accept: opts.accept || "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8",
        "accept-language": "sv,en;q=0.8",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

    const maxRedirects = opts.maxRedirects ?? 5;
    let currentUrl = rawUrl;

    try {
        for (let hop = 0; ; hop++) {
            await assertSafeUrl(currentUrl);

            const resp = await fetch(currentUrl, {
                redirect: "manual",
                signal: controller.signal,
                headers,
                size: opts.maxBytes || 8 * 1024 * 1024,
            });

            // Follow redirects ourselves, re-validating every hop.
            if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
                if (hop >= maxRedirects) {
                    const e = new Error("För många omdirigeringar");
                    e.code = "too_many_redirects";
                    throw e;
                }
                currentUrl = new URL(resp.headers.get("location"), currentUrl).toString();
                continue;
            }

            if (resp.status === 304) {
                return { status: 304, notModified: true, finalUrl: currentUrl };
            }
            // Rate limited / temporarily unavailable — honor Retry-After if present.
            if (resp.status === 429 || resp.status === 503) {
                const e = new Error(`HTTP ${resp.status}`);
                e.code = "rate_limited";
                e.status = resp.status;
                e.retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
                throw e;
            }
            if (!resp.ok) {
                const e = new Error(`HTTP ${resp.status}`);
                e.code = "http_error";
                e.status = resp.status;
                throw e;
            }

            return {
                status: resp.status,
                notModified: false,
                body: await resp.text(),
                contentType: resp.headers.get("content-type") || "",
                etag: resp.headers.get("etag") || null,
                lastModified: resp.headers.get("last-modified") || null,
                finalUrl: currentUrl,
            };
        }
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { fetchUrl, parseRetryAfter };
