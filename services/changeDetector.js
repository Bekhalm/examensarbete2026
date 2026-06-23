const cheerio = require("cheerio");
const crypto = require("crypto");

const config = require("../lib/config");
const logger = require("../lib/logger");
const { fetchUrl } = require("../lib/http");
const { looksLikeFeed } = require("./feeds");
const render = require("./render");
const notifier = require("./notifier");

const {
    getSourceById,
    updateSource,
    getSeenItemIds,
    addSeenItems,
    pruneSeenItems,
} = require("../db/database");

function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

// Containers that change on almost every page load (cookie banners, ads,
// "most read"/recommended widgets, nav, etc.) and cause false alarms.
const NOISE_SELECTORS = [
    "script", "style", "noscript", "template", "svg", "iframe",
    "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='complementary']", "[role='search']",
    "[id*='cookie']", "[class*='cookie']",
    "[id*='consent']", "[class*='consent']",
    "[id*='gdpr']", "[class*='gdpr']",
    "[id*='banner']", "[class*='banner']",
    "[id*='advert']", "[class*='advert']", "[class*='ad-']", "[class*='-ad']", "[id*='google_ads']",
    "[class*='promo']", "[class*='sponsor']", "[class*='newsletter']",
    "[class*='related']", "[class*='popular']", "[class*='most-read']", "[class*='mostread']",
    "[class*='mest-last']", "[class*='mest_last']", "[class*='trending']", "[class*='recommend']",
    "[class*='menu']", "[class*='nav']", "[class*='sidebar']",
    "[class*='footer']", "[class*='header']", "[class*='share']", "[class*='social']",
    "time", "[datetime]", "[class*='timestamp']", "[class*='time-ago']", "[class*='viewcount']", "[class*='counter']",
];

function stripNoise($) {
    try {
        $(NOISE_SELECTORS.join(", ")).remove();
    } catch {
        $("script, style, noscript, nav, header, footer, aside").remove();
    }
}

function normalizeTextFromHtml(html, selector) {
    const $ = cheerio.load(html);
    stripNoise($);
    let container = selector ? $(selector).first() : $();
    if (!container.length) container = $("main, article, [role='main'], #content, .content").first();
    const text = (container.length ? container : $("body")).text();
    return text.replace(/\s+/g, " ").trim();
}

function isLikelyArticleUrl(candidateUrl, sourceUrl) {
    try {
        const url = new URL(candidateUrl);
        const base = new URL(sourceUrl);
        const sameSite =
            url.hostname === base.hostname ||
            url.hostname.endsWith("." + base.hostname) ||
            base.hostname.endsWith("." + url.hostname);
        if (!sameSite) return false;

        const path = url.pathname;
        if (path === "" || path === "/") return false;

        const segments = path.split("/").filter(Boolean);
        const slug = segments[segments.length - 1] || "";
        return (
            /\d{4,}/.test(path) ||
            /\/(artikel|article|nyhet|nyheter|story|a|pressmeddelande|news)\//i.test(path) ||
            (segments.length >= 2 && slug.includes("-") && slug.replace(/-/g, "").length >= 12)
        );
    } catch {
        return false;
    }
}

// Native advertising / affiliate commerce that some sites publish dressed up as
// articles. We drop these during extraction so they never trigger an alert.
const COMMERCIAL_URL_SEGMENTS = new Set([
    "brandstudio", "brand-studio", "partnerstudio", "annons", "annonser",
    "annonsor", "annonsorinnehall", "annonssamarbete", "sponsrat", "sponsrad",
    "sponsored", "advertorial", "reklam", "rabattkod", "rabattkoder",
    "erbjudande", "erbjudanden", "affiliate", "shopping",
]);

function isCommercialUrl(candidateUrl) {
    try {
        const segments = new URL(candidateUrl).pathname.toLowerCase().split("/").filter(Boolean);
        return segments.some((s) => COMMERCIAL_URL_SEGMENTS.has(s));
    } catch {
        return false;
    }
}

// Affiliate "shopping listicle" headlines (köpguider, rabatt-tips, "X mest sålda
// …", "X bästa … köpen under N kronor"). Kept tight so real news/consumer
// journalism isn't swept up: a plain "30 bästa sommarpratare" stays.
function looksLikeShoppingAd(title) {
    if (!title) return false;
    const t = title.toLowerCase();
    if (/\bmest sålda\b/.test(t)) return true;
    if (/rabattkod|köpguide|köptips|bäst i test|prisvärd|\bfynd(a|en|et)?\b/.test(t)) return true;
    if (
        /\b\d{1,3}\s+(bästa|smartaste|snyggaste|billigaste|prisvärda|hetaste)\b/.test(t) &&
        /(köp|kronor|\bkr\b|pris|budget|under\s+\d+)/.test(t)
    ) {
        return true;
    }
    return false;
}

function isCommercialItem(url, title) {
    return (!!url && isCommercialUrl(url)) || looksLikeShoppingAd(title);
}

function toIsoOrNull(value) {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

function newestIsoFrom(values) {
    let newest = null;
    for (const value of values) {
        const iso = toIsoOrNull(value);
        if (iso && (!newest || iso > newest)) newest = iso;
    }
    return newest;
}

// Pull the newest datePublished/dateModified from JSON-LD blocks — the most
// reliable "when did this page actually change" signal when present.
function extractJsonLdDates(html) {
    const $ = cheerio.load(html);
    const found = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!raw) return;
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }
        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) return node.forEach(walk);
            for (const key of ["datePublished", "dateModified", "dateCreated"]) {
                if (node[key]) found.push(node[key]);
            }
            Object.values(node).forEach(walk);
        };
        walk(data);
    });
    return newestIsoFrom(found);
}

function parseClockTimeFromText(text, nowIso) {
    if (!text) return null;
    const match = text.match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/);
    if (!match) return null;
    const now = nowIso ? new Date(nowIso) : new Date();
    if (Number.isNaN(now.getTime())) return null;
    const candidate = new Date(now);
    candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (candidate.getTime() - now.getTime() > 5 * 60 * 1000) {
        candidate.setDate(candidate.getDate() - 1);
    }
    return candidate.toISOString();
}

function isHttpUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function stripTrackingParams(urlString) {
    const tracked = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    const u = new URL(urlString);
    for (const key of tracked) u.searchParams.delete(key);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") u.pathname = u.pathname.slice(0, -1);
    return u.toString();
}

function normalizeArticleUrl(candidate, baseUrl) {
    if (!candidate) return null;
    try {
        const normalized = stripTrackingParams(new URL(candidate, baseUrl).toString());
        return isHttpUrl(normalized) ? normalized : null;
    } catch {
        return null;
    }
}

function extractFeedLink($item) {
    const href = $item.find("link").first().attr("href");
    if (href) return href.trim();
    const rssLink = $item.find("link").first().text();
    return rssLink ? rssLink.trim() : "";
}

function extractItemsFromFeed(body, sourceUrl) {
    const $ = cheerio.load(body, { xmlMode: true });
    const items = [];
    const dedupe = new Set();

    $("item, entry").each((_, el) => {
        if (items.length >= config.maxItemsPerCheck) return false;
        const $item = $(el);
        const title = ($item.find("title").first().text() || "").replace(/\s+/g, " ").trim();
        const rawLink = extractFeedLink($item);
        const normalizedUrl = normalizeArticleUrl(rawLink, sourceUrl);
        const guid = ($item.find("guid, id").first().text() || "").trim();
        const publishedAt = ($item.find("pubDate, published, updated").first().text() || "").trim();

        const stableKey = guid || normalizedUrl || `${title}|${publishedAt}`;
        if (!stableKey) return;
        const itemId = sha256(stableKey);
        if (dedupe.has(itemId)) return;
        dedupe.add(itemId);

        items.push({ item_id: itemId, title: title || "(untitled)", url: normalizedUrl, published_at: toIsoOrNull(publishedAt) });
    });
    return items;
}

function extractItemsFromHtml(body, sourceUrl, nowIso, selector) {
    const $ = cheerio.load(body);
    const items = [];
    const dedupe = new Set();

    stripNoise($);

    let root = selector ? $(selector).first() : $();
    if (!root.length) root = $("main, article, [role='main'], #content, .content").first();
    const scope = root.length ? root : $("body");

    scope.find("a[href]").each((_, el) => {
        if (items.length >= config.maxItemsPerCheck) return false;
        const href = $(el).attr("href");
        const text = ($(el).text() || "").replace(/\s+/g, " ").trim();
        if (!href || text.length < 12) return;
        if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;

        const normalizedUrl = normalizeArticleUrl(href, sourceUrl);
        if (!normalizedUrl) return;
        if (!isLikelyArticleUrl(normalizedUrl, sourceUrl)) return;
        if (isCommercialItem(normalizedUrl, text)) return;

        const itemId = sha256(normalizedUrl);
        if (dedupe.has(itemId)) return;
        dedupe.add(itemId);

        items.push({ item_id: itemId, title: text, url: normalizedUrl, published_at: parseClockTimeFromText(text, nowIso) });
    });
    return items;
}

// Many modern live pages (Next.js etc.) render their flow client-side, so the
// posts aren't in the static DOM — but they ARE embedded as JSON in a
// <script id="__NEXT_DATA__"> (or similar) blob. We pull the live posts straight
// from that JSON: any object carrying both a headline (title/headline) and a
// publish timestamp is a flow post. This is fast (no headless browser) and gives
// us stable ids + real timestamps. Returns [] when no such JSON is present, so
// callers fall back to DOM scraping.
const JSON_TITLE_KEYS = ["title", "headline", "heading"];
const JSON_DATE_KEYS = ["publishedAt", "firstPublishedAt", "datePublished", "published_at", "date"];

function extractEmbeddedJsonItems(body) {
    const items = [];
    const dedupe = new Set();

    let match = body.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return items;

    let data;
    try {
        data = JSON.parse(match[1]);
    } catch {
        return items;
    }

    const walk = (node) => {
        if (items.length >= config.maxItemsPerCheck) return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (!node || typeof node !== "object") return;

        let title = null;
        for (const k of JSON_TITLE_KEYS) {
            if (typeof node[k] === "string" && node[k].trim()) { title = node[k].trim(); break; }
        }
        let dateRaw = null;
        for (const k of JSON_DATE_KEYS) {
            if (node[k]) { dateRaw = node[k]; break; }
        }
        const publishedAt = toIsoOrNull(dateRaw);

        // A flow post = has a headline of reasonable length AND a real timestamp.
        if (title && publishedAt && title.length >= 8 && title.length <= 240) {
            const stableId = node.id || node._id || node.uuid || node.guid || null;
            const itemId = sha256(stableId ? `jid:${stableId}` : `h:${title.toLowerCase()}`);
            if (!dedupe.has(itemId)) {
                dedupe.add(itemId);
                items.push({ item_id: itemId, title, url: null, published_at: publishedAt });
            }
        }

        for (const value of Object.values(node)) walk(value);
    };

    walk(data);
    return items;
}

// Live-ticker / "direkt" feeds are short headline posts, often without their
// own article URL — so the link-based extractor misses them. Here we capture
// the headline text itself as the item (deduped by text), which is exactly the
// signal a journalist wants: "a new flash just appeared".
const HEADLINE_SELECTOR = "h1, h2, h3, h4, [class*='title'], [class*='headline'], [class*='rubrik']";

function extractHeadlineItems(body, sourceUrl, nowIso, selector) {
    const $ = cheerio.load(body);
    const items = [];
    const dedupe = new Set();

    stripNoise($);

    let root = selector ? $(selector).first() : $();
    if (!root.length) root = $("main, article, [role='main'], #content, .content").first();
    const scope = root.length ? root : $("body");

    scope.find(HEADLINE_SELECTOR).each((_, el) => {
        if (items.length >= config.maxItemsPerCheck) return false;
        const $el = $(el);
        let text = ($el.text() || "").replace(/\s+/g, " ").trim();
        // Strip a trailing video-duration overlay (e.g. '…Frankrike1:01' or
        // '… 2:30') that some player cards glue onto the headline text.
        text = text.replace(/\s*\d{1,2}:\d{2}$/, "").trim();
        // Skip empties, nav-length scraps, and huge concatenations (a wrapper
        // that swept up many posts at once).
        if (text.length < 12 || text.length > 240) return;

        const itemId = sha256("h:" + text.toLowerCase());
        if (dedupe.has(itemId)) return;
        dedupe.add(itemId);

        let href = $el.find("a[href]").first().attr("href") || $el.closest("a[href]").attr("href");
        const url = href ? normalizeArticleUrl(href, sourceUrl) : null;
        if (isCommercialItem(url, text)) return;

        items.push({ item_id: itemId, title: text, url, published_at: parseClockTimeFromText(text, nowIso) });
    });
    return items;
}

function getSiteChangedAt(unseenItems) {
    return newestIsoFrom(unseenItems.map((item) => item.published_at).filter(Boolean));
}

async function getBody(source) {
    // Ticker mode always watches the page itself (never a site-wide feed).
    const targetUrl = source.extract_mode === "ticker"
        ? source.url
        : (source.feed_url || source.url);
    if (source.render_mode === "js") {
        const html = await render.renderHtml(targetUrl);
        if (html != null) {
            return { body: html, contentType: "text/html", etag: null, lastModified: null, notModified: false };
        }
        // fall back to static fetch if rendering unavailable
    }
    return fetchUrl(targetUrl, { etag: source.etag, lastModified: source.last_modified });
}

async function checkOneSourceById(id) {
    const source = await getSourceById(id);
    if (!source) return { ok: false, reason: "not_found" };
    if (source.is_active === 0) return { ok: false, reason: "inactive" };

    const now = new Date().toISOString();
    const lastNotifiedMs = source.last_notified_at ? new Date(source.last_notified_at).getTime() : 0;
    const cooldownPassed = Date.now() - lastNotifiedMs >= config.cooldownMs;

    try {
        const res = await getBody(source);

        // Conditional GET said nothing changed.
        if (res.notModified) {
            await updateSource(id, { last_checked_at: now, last_error: null, consecutive_failures: 0, last_status: "304", next_retry_at: null });
            return baseResult(source, { changed: false, notify: false, not_modified: true, last_checked_at: now });
        }

        const { body, contentType } = res;
        const httpMeta = { etag: res.etag, last_modified: res.lastModified };

        let extractedItems;
        if (source.extract_mode === "ticker") {
            // Prefer flow posts embedded as JSON (client-rendered live pages);
            // fall back to scraping headline elements from the static DOM.
            extractedItems = extractEmbeddedJsonItems(body);
            if (!extractedItems.length) {
                extractedItems = extractHeadlineItems(body, source.url, now, source.selector);
            }
        } else if (looksLikeFeed(body, contentType)) {
            extractedItems = extractItemsFromFeed(body, source.feed_url || source.url);
        } else {
            extractedItems = extractItemsFromHtml(body, source.url, now, source.selector);
        }

        const items = extractedItems.slice(0, config.maxItemsPerCheck);
        const seenIds = new Set(await getSeenItemIds(source.id));
        const isFirstCheck = !source.last_checked_at;

        // ----- Fallback: no items found -> de-noised text hash -----
        if (items.length === 0) {
            const newHash = sha256(normalizeTextFromHtml(body, source.selector));
            const hadHashBefore = !!source.last_hash;
            const changed = !isFirstCheck && hadHashBefore && source.last_hash !== newHash;
            const siteChangedAt = changed ? extractJsonLdDates(body) || now : null;

            const notify = changed && cooldownPassed;
            await updateSource(id, {
                last_hash: newHash,
                last_checked_at: now,
                last_detected_at: changed ? now : source.last_detected_at,
                last_changed_at: siteChangedAt || source.last_changed_at,
                last_notified_at: notify ? now : source.last_notified_at,
                last_error: null,
                consecutive_failures: 0,
                last_status: String(res.status || 200),
                next_retry_at: null,
                ...httpMeta,
            });

            const result = baseResult(source, {
                changed, notify, new_items_count: 0, latest_item_title: null,
                last_checked_at: now,
                last_detected_at: changed ? now : source.last_detected_at,
                last_changed_at: siteChangedAt || source.last_changed_at,
                last_notified_at: notify ? now : source.last_notified_at,
            });
            if (notify) notifier.notifyChange(source, result);
            return result;
        }

        // ----- Item-based diffing (preferred) -----
        const unseenItems = items.filter((item) => !seenIds.has(item.item_id));
        await addSeenItems(source.id, items, now);
        await pruneSeenItems(source.id, config.seenItemsKeepPerSource);

        const isBaselineItemsRun = isFirstCheck || seenIds.size === 0;
        const newHash = sha256(items.map((i) => i.item_id).join("|"));
        const changed = !isBaselineItemsRun && unseenItems.length > 0;
        const siteChangedAt = changed ? getSiteChangedAt(unseenItems) || extractJsonLdDates(body) || now : null;

        const notify = changed && cooldownPassed;
        await updateSource(id, {
            last_hash: newHash,
            last_checked_at: now,
            last_detected_at: changed ? now : source.last_detected_at,
            last_changed_at: siteChangedAt || source.last_changed_at,
            last_notified_at: notify ? now : source.last_notified_at,
            last_error: null,
            consecutive_failures: 0,
            last_status: String(res.status || 200),
            next_retry_at: null,
            ...httpMeta,
        });

        const result = baseResult(source, {
            changed, notify,
            new_items_count: changed ? unseenItems.length : 0,
            latest_item_title: unseenItems[0]?.title || null,
            latest_item_url: unseenItems[0]?.url || null,
            last_checked_at: now,
            last_detected_at: changed ? now : source.last_detected_at,
            last_changed_at: siteChangedAt || source.last_changed_at,
            last_notified_at: notify ? now : source.last_notified_at,
        });
        if (notify) notifier.notifyChange(source, result);
        return result;
    } catch (err) {
        const failures = (source.consecutive_failures || 0) + 1;
        const fields = {
            last_checked_at: now,
            last_error: err.message || "Okänt fel",
            consecutive_failures: failures,
            last_status: err.status ? String(err.status) : err.code || "error",
        };
        // Honor an explicit Retry-After from a 429/503 response.
        if (err.retryAfterMs && err.retryAfterMs > 0) {
            fields.next_retry_at = new Date(Date.now() + err.retryAfterMs).toISOString();
        }
        await updateSource(id, fields);
        logger.warn({ id, url: source.url, err: err.message, failures, status: err.status }, "source check failed");
        return { ok: false, reason: "fetch_error", id: source.id, name: source.name, url: source.url, error_message: err.message };
    }
}

function baseResult(source, extra) {
    return {
        ok: true,
        id: source.id,
        name: source.name,
        url: source.url,
        changed: false,
        notify: false,
        not_modified: false,
        new_items_count: 0,
        latest_item_title: null,
        latest_item_url: null,
        last_checked_at: source.last_checked_at,
        last_detected_at: source.last_detected_at,
        last_changed_at: source.last_changed_at,
        last_notified_at: source.last_notified_at,
        ...extra,
    };
}

module.exports = {
    checkOneSourceById,
    // exported for tests:
    isLikelyArticleUrl,
    isCommercialUrl,
    looksLikeShoppingAd,
    extractItemsFromFeed,
    extractItemsFromHtml,
    extractHeadlineItems,
    normalizeTextFromHtml,
    extractJsonLdDates,
};
