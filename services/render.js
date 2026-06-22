const config = require("../lib/config");
const logger = require("../lib/logger");
const { assertSafeUrl } = require("../lib/safeUrl");

// Domains whose requests we drop while rendering, so ads/analytics/consent
// scripts can't introduce noise or slow the render down.
const BLOCKED_HOSTS = [
    "doubleclick.net", "googlesyndication.com", "google-analytics.com", "googletagmanager.com",
    "facebook.net", "facebook.com", "hotjar.com", "scorecardresearch.com", "criteo.com",
    "adnxs.com", "taboola.com", "outbrain.com", "cxense.com", "cookiebot.com", "onetrust.com",
    "consensu.org", "quantserve.com", "amazon-adsystem.com",
];

let browserPromise = null;
let playwright = null;
let unavailable = false;

async function getBrowser() {
    if (unavailable) return null;
    if (!playwright) {
        try {
            playwright = require("playwright");
        } catch {
            unavailable = true;
            logger.warn("playwright not installed — JS rendering disabled (run: npm i playwright && npx playwright install chromium)");
            return null;
        }
    }
    if (!browserPromise) {
        browserPromise = playwright.chromium
            .launch({ headless: true })
            .catch((err) => {
                unavailable = true;
                logger.warn({ err: err.message }, "Could not launch browser — JS rendering disabled");
                browserPromise = null;
                return null;
            });
    }
    return browserPromise;
}

// Renders a page with a headless browser and returns its HTML, or null if
// rendering is unavailable (caller should fall back to a static fetch).
async function renderHtml(rawUrl) {
    await assertSafeUrl(rawUrl);
    const browser = await getBrowser();
    if (!browser) return null;

    const context = await browser.newContext({ userAgent: config.userAgent });
    const page = await context.newPage();
    try {
        await page.route("**/*", async (route) => {
            const req = route.request();
            const reqUrl = req.url();
            const type = req.resourceType();
            if (type === "image" || type === "media" || type === "font") return route.abort();
            if (BLOCKED_HOSTS.some((h) => reqUrl.includes(h))) return route.abort();
            // Re-validate page navigations (incl. redirects) so the browser can't
            // be steered to an internal/metadata address — same SSRF guard as fetch.
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                try {
                    await assertSafeUrl(reqUrl);
                } catch {
                    return route.abort();
                }
            }
            return route.continue();
        });
        await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: config.fetchTimeoutMs });
        await page.waitForTimeout(800);
        return await page.content();
    } finally {
        await context.close().catch(() => {});
    }
}

async function close() {
    if (browserPromise) {
        const b = await browserPromise;
        if (b) await b.close().catch(() => {});
    }
}

module.exports = { renderHtml, close };
