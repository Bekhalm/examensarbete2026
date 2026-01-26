const fetch = require("node-fetch");
const cheerio = require("cheerio");
const crypto = require("crypto");

const { getSourceById, updateSourceCheck } = require("../db/database");

function normalizeTextFromHtml(html) {
    const $ = cheerio.load(html);

    $("script, style, noscript").remove();

    const text = $("body").text();
    return text.replace(/\s+/g, " ").trim();
}

function sha256(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}

async function checkOneSourceById(id) {
    const source = await getSourceById(id);
    if (!source) return { ok: false, reason: "not_found" };
    if (source.is_active === 0) return { ok: false, reason: "inactive" };

    const resp = await fetch(source.url, { redirect: "follow" });
    const html = await resp.text();

    const normalized = normalizeTextFromHtml(html);
    const newHash = sha256(normalized);
    const now = new Date().toISOString();

    const hadHashBefore = !!source.last_hash;
    const changed = hadHashBefore && source.last_hash !== newHash;
    const lastChangedAt = changed ? now : null;

    await updateSourceCheck(source.id, {
        last_hash: newHash,
        last_checked_at: now,
        last_changed_at: lastChangedAt,
    });

    return {
        ok: true,
        id: source.id,
        name: source.name,
        url: source.url,
        changed,
        last_checked_at: now,
        last_changed_at: changed ? now : source.last_changed_at,
    };
}

module.exports = {
    checkOneSourceById,
};
