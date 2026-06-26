const cheerio = require("cheerio");
const { fetchUrl } = require("../lib/http");
const logger = require("../lib/logger");

const COMMON_FEED_PATHS = ["/rss", "/rss.xml", "/feed", "/feed.xml", "/atom.xml", "/index.xml", "/feeds/all.atom.xml"];

function looksLikeFeed(body, contentType = "") {
    const prefix = (body || "").slice(0, 800).toLowerCase();
    return (
        contentType.includes("xml") ||
        contentType.includes("rss") ||
        contentType.includes("atom") ||
        prefix.includes("<rss") ||
        prefix.includes("<feed") ||
        prefix.includes("<entry") ||
        prefix.includes("<item")
    );
}

// Score a candidate feed against the page the user submitted.
function scoreFeed(feedUrl, pageUrl, title = "") {
    let score = 0;
    try {
        const f = new URL(feedUrl);
        const p = new URL(pageUrl);
        if (f.hostname === p.hostname) score += 5;

        const fSeg = f.pathname.split("/").filter(Boolean);
        const pSeg = p.pathname.split("/").filter(Boolean);
        let common = 0;
        for (let i = 0; i < Math.min(fSeg.length, pSeg.length); i++) {
            if (fSeg[i] === pSeg[i]) common++;
            else break;
        }
        score += common * 3; // section match is valuable
    } catch {
        /* ignore */
    }
    const t = (title || "").toLowerCase();
    if (/(comment|kommentar|podcast|replies)/.test(t)) score -= 6; // noisy feeds
    return score;
}

// Parse <link rel="alternate" type="...rss/atom..."> from a page's HTML.
function feedsFromHtml(html, pageUrl) {
    const $ = cheerio.load(html);
    const out = [];
    $('link[rel="alternate"]').each((_, el) => {
        const type = ($(el).attr("type") || "").toLowerCase();
        const href = $(el).attr("href");
        if (!href) return;
        if (!type.includes("rss") && !type.includes("atom")) return;
        try {
            out.push({
                url: new URL(href, pageUrl).toString(),
                title: $(el).attr("title") || "",
                type: type.includes("atom") ? "atom" : "rss",
            });
        } catch {
            /* ignore */
        }
    });
    return out;
}

// Full discovery: parse the page, then probe common paths, validate, and rank.
async function discoverFeeds(pageUrl) {
    const candidates = new Map(); // url -> {url,title,type}

    let html = null;
    try {
        const res = await fetchUrl(pageUrl);
        if (!res.notModified) {
            html = res.body;
            if (looksLikeFeed(res.body, res.contentType)) {
                // The submitted URL is itself a feed.
                return [{ url: pageUrl, title: "", type: "rss", verified: true, self: true }];
            }
        }
    } catch (err) {
        logger.debug({ err: err.message, pageUrl }, "discoverFeeds: page fetch failed");
    }

    if (html) {
        for (const f of feedsFromHtml(html, pageUrl)) candidates.set(f.url, f);
    }

    // Probe a few conventional locations if the page didn't advertise feeds.
    if (candidates.size === 0) {
        let origin;
        try {
            origin = new URL(pageUrl).origin;
        } catch {
            origin = null;
        }
        if (origin) {
            for (const p of COMMON_FEED_PATHS) {
                const u = origin + p;
                try {
                    const res = await fetchUrl(u);
                    if (!res.notModified && looksLikeFeed(res.body, res.contentType)) {
                        candidates.set(u, { url: u, title: "", type: "rss", verified: true });
                    }
                } catch {
                    /* not found, ignore */
                }
            }
        }
    }

    const ranked = [...candidates.values()]
        .map((c) => ({ ...c, score: scoreFeed(c.url, pageUrl, c.title) }))
        .sort((a, b) => b.score - a.score);

    return ranked;
}

module.exports = { discoverFeeds, looksLikeFeed };
