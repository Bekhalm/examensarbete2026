const fetch = require("node-fetch");
const cheerio = require("cheerio");
const crypto = require("crypto");

const COOLDOWN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS_PER_CHECK = 40;

const {
    getSourceById,
    updateSourceCheck,
    updateLastNotified,
    getSeenItemIds,
    addSeenItems,
} = require("../db/database");

function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeTextFromHtml(html) {
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    const text = $("body").text();
    return text.replace(/\s+/g, " ").trim();
}

function toIsoOrNull(value) {
    if (!value) return null;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return null;
    return new Date(timestamp).toISOString();
}

function newestIsoFrom(values) {
    let newest = null;
    for (const value of values) {
        const iso = toIsoOrNull(value);
        if (!iso) continue;
        if (!newest || iso > newest) newest = iso;
    }
    return newest;
}

function parseClockTimeFromText(text, nowIso) {
    if (!text) return null;
    const match = text.match(/\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const now = nowIso ? new Date(nowIso) : new Date();
    if (Number.isNaN(now.getTime())) return null;

    const candidate = new Date(now);
    candidate.setHours(hours, minutes, 0, 0);

    // If parsed time is far ahead of "now", assume it belongs to previous day.
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
    const tracked = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
    ];

    const u = new URL(urlString);
    for (const key of tracked) {
        u.searchParams.delete(key);
    }

    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname !== "/") {
        u.pathname = u.pathname.slice(0, -1);
    }
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
    if (rssLink) return rssLink.trim();
    return "";
}

function extractItemsFromFeed(body, sourceUrl) {
    const $ = cheerio.load(body, { xmlMode: true });
    const items = [];
    const dedupe = new Set();

    $("item, entry").each((_, el) => {
        if (items.length >= MAX_ITEMS_PER_CHECK) return false;

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

        items.push({
            item_id: itemId,
            title: title || "(untitled)",
            url: normalizedUrl,
            published_at: toIsoOrNull(publishedAt),
        });
    });

    return items;
}

function extractItemsFromHtml(body, sourceUrl, nowIso) {
    const $ = cheerio.load(body);
    const items = [];
    const dedupe = new Set();

    // Remove common noisy areas first to reduce false positives.
    $(
        "script, style, noscript, nav, footer, [id*='cookie'], [class*='cookie'], [id*='consent'], [class*='consent'], [class*='ad'], [id*='ad']"
    ).remove();

    $("a[href]").each((_, el) => {
        if (items.length >= MAX_ITEMS_PER_CHECK) return false;
        const href = $(el).attr("href");
        const text = ($(el).text() || "").replace(/\s+/g, " ").trim();
        if (!href || text.length < 12) return;
        if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;

        const normalizedUrl = normalizeArticleUrl(href, sourceUrl);
        if (!normalizedUrl) return;

        const itemId = sha256(normalizedUrl);
        if (dedupe.has(itemId)) return;
        dedupe.add(itemId);

        items.push({
            item_id: itemId,
            title: text,
            url: normalizedUrl,
            published_at: parseClockTimeFromText(text, nowIso),
        });
    });

    return items;
}

function getSiteChangedAt(unseenItems) {
    return newestIsoFrom(unseenItems.map((item) => item.published_at).filter(Boolean));
}

function looksLikeFeed(body, contentType = "") {
    const prefix = (body || "").slice(0, 800).toLowerCase();
    return (
        contentType.includes("xml") ||
        prefix.includes("<rss") ||
        prefix.includes("<feed") ||
        prefix.includes("<entry") ||
        prefix.includes("<item")
    );
}

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const resp = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: { "user-agent": "newsroom-monitor-mvp/1.0" },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const contentType = resp.headers.get("content-type") || "";
        const body = await resp.text();
        return { body, contentType };
    } finally {
        clearTimeout(timeout);
    }
}

async function checkOneSourceById(id) {
    const source = await getSourceById(id);
    if (!source) return { ok: false, reason: "not_found" };
    if (source.is_active === 0) return { ok: false, reason: "inactive" };

    const now = new Date().toISOString();
    const lastNotifiedMs = source.last_notified_at
        ? new Date(source.last_notified_at).getTime()
        : 0;
    const cooldownPassed = Date.now() - lastNotifiedMs >= COOLDOWN_MS;

    try {
        const { body, contentType } = await fetchWithTimeout(source.url);

        const extractedItems = looksLikeFeed(body, contentType)
            ? extractItemsFromFeed(body, source.url)
            : extractItemsFromHtml(body, source.url, now);

        const items = extractedItems.slice(0, MAX_ITEMS_PER_CHECK);
        const seenIds = new Set(await getSeenItemIds(source.id));
        const unseenItems = items.filter((item) => !seenIds.has(item.item_id));
        const isFirstCheck = !source.last_checked_at;

        if (items.length === 0) {
            const normalized = normalizeTextFromHtml(body);
            const newHash = sha256(normalized);
            const hadHashBefore = !!source.last_hash;
            const changed = !isFirstCheck && hadHashBefore && source.last_hash !== newHash;

            await updateSourceCheck(source.id, {
                last_hash: newHash,
                last_checked_at: now,
                last_detected_at: changed ? now : null,
                last_changed_at: null,
                update_last_changed: false,
            });

            let notify = false;
            if (changed && cooldownPassed) {
                notify = true;
                await updateLastNotified(source.id, now);
            }

            return {
                ok: true,
                id: source.id,
                name: source.name,
                url: source.url,
                changed,
                notify,
                new_items_count: 0,
                latest_item_title: null,
                last_checked_at: now,
                last_detected_at: changed ? now : source.last_detected_at,
                last_changed_at: source.last_changed_at,
                last_notified_at: notify ? now : source.last_notified_at,
            };
        }

        await addSeenItems(source.id, items, now);

        const isBaselineItemsRun = isFirstCheck || seenIds.size === 0;
        const newHash = sha256(items.map((i) => i.item_id).join("|"));
        const changed = !isBaselineItemsRun && unseenItems.length > 0;
        const siteChangedAt = changed ? getSiteChangedAt(unseenItems) : null;

        await updateSourceCheck(source.id, {
            last_hash: newHash,
            last_checked_at: now,
            last_detected_at: changed ? now : null,
            last_changed_at: siteChangedAt,
            update_last_changed: changed && siteChangedAt !== null,
        });

        let notify = false;
        if (changed && cooldownPassed) {
            notify = true;
            await updateLastNotified(source.id, now);
        }

        return {
            ok: true,
            id: source.id,
            name: source.name,
            url: source.url,
            changed,
            notify,
            new_items_count: changed ? unseenItems.length : 0,
            latest_item_title: unseenItems[0]?.title || null,
            last_checked_at: now,
            last_detected_at: changed ? now : source.last_detected_at,
            last_changed_at: changed && siteChangedAt ? siteChangedAt : source.last_changed_at,
            last_notified_at: notify ? now : source.last_notified_at,
        };
    } catch (err) {
        await updateSourceCheck(source.id, {
            last_hash: source.last_hash,
            last_checked_at: now,
            last_detected_at: null,
            last_changed_at: null,
            update_last_changed: false,
        });

        return {
            ok: false,
            reason: "fetch_error",
            id: source.id,
            name: source.name,
            url: source.url,
            error_message: err.message || "Unknown fetch error",
        };
    }
}

module.exports = {
    checkOneSourceById,
};
