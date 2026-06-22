const { test } = require("node:test");
const assert = require("node:assert");
const det = require("../services/changeDetector");

test("isLikelyArticleUrl: keeps articles, drops sections & cross-site", () => {
    assert.equal(
        det.isLikelyArticleUrl("https://ex.se/nyheter/sverige/lang-rubrik-har-2026", "https://ex.se/nyheter"),
        true
    );
    assert.equal(det.isLikelyArticleUrl("https://ex.se/a/123456", "https://ex.se"), true);
    assert.equal(det.isLikelyArticleUrl("https://ex.se/sport", "https://ex.se/nyheter"), false);
    assert.equal(det.isLikelyArticleUrl("https://other.com/a/123456", "https://ex.se"), false);
});

test("isCommercialUrl flags native-ad/affiliate sections, keeps news", () => {
    assert.equal(det.isCommercialUrl("https://www.expressen.se/brandstudio/wellvita/x/"), true);
    assert.equal(det.isCommercialUrl("https://ex.se/annonssamarbete/foo/"), true);
    assert.equal(det.isCommercialUrl("https://ex.se/nyheter/sverige/riktig-nyhet-2026/"), false);
    assert.equal(det.isCommercialUrl("https://ex.se/skonhet/bast-i-test/"), false);
});

test("looksLikeShoppingAd catches köp-listicles but spares real news/editorial", () => {
    assert.equal(det.looksLikeShoppingAd("Topplistan: 30 mest sålda sexleksakerna"), true);
    assert.equal(det.looksLikeShoppingAd("30 bästa skönhetsköpen under 300 kronor"), true);
    assert.equal(det.looksLikeShoppingAd("Bäst i test av budgetschampo – fynden"), true);
    assert.equal(det.looksLikeShoppingAd("30 bästa sommarpratare 2026 – betyg på alla"), false);
    assert.equal(det.looksLikeShoppingAd("Bada i färg – trendigt badrum i tre stilar"), false);
    assert.equal(det.looksLikeShoppingAd("Polisen: Hon mördade Marie i Stuvkällaren"), false);
});

test("extractItemsFromHtml drops sponsored/affiliate items", () => {
    const html = `<html><body><main>
        <a href="/nyheter/sverige/riktig-nyhetsrubrik-har-2026">Riktig nyhetsrubrik som ska behållas</a>
        <a href="/brandstudio/wellvita/minska-svullnaden-i-fotterna">Så kan du minska svullnaden i fötterna</a>
        <a href="/skonhet/lista-har/30-basta-skonhetskopen">30 bästa skönhetsköpen under 300 kronor</a>
    </main></body></html>`;
    const items = det.extractItemsFromHtml(html, "https://ex.se/", new Date().toISOString(), null);
    const titles = items.map((i) => i.title);
    assert.equal(items.length, 1);
    assert.ok(titles[0].startsWith("Riktig nyhetsrubrik"));
});

test("extractItemsFromFeed parses RSS items", () => {
    const rss = `<?xml version="1.0"?><rss><channel>
        <item><title>Hej</title><link>https://ex.se/a/1</link><guid>g1</guid><pubDate>Wed, 01 Jan 2026 10:00:00 GMT</pubDate></item>
        <item><title>Då</title><link>https://ex.se/a/2</link><guid>g2</guid></item>
    </channel></rss>`;
    const items = det.extractItemsFromFeed(rss, "https://ex.se");
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "Hej");
    assert.ok(items[0].published_at);
});

test("extractItemsFromHtml ignores nav/widgets, keeps real articles", () => {
    const html = `<html><body>
        <nav><a href="/sport">Sport menyval here</a></nav>
        <main><a href="/nyheter/sverige/lang-rubrik-2026">En riktig nyhetsrubrik här</a></main>
        <aside class="mest-last"><a href="/nyheter/annat/blabla-grej-2025">Mest laest grej har</a></aside>
    </body></html>`;
    const items = det.extractItemsFromHtml(html, "https://ex.se", "2026-01-01T00:00:00Z");
    assert.ok(items.some((i) => /lang-rubrik/.test(i.url)), "should keep main article");
    assert.ok(!items.some((i) => /blabla-grej/.test(i.url)), "should drop mest-last widget");
    assert.ok(!items.some((i) => /sport/.test(i.url)), "should drop nav");
});

test("extractHeadlineItems captures live-blog posts (incl. linkless), drops nav & short scraps", () => {
    const html = `<html><body>
        <nav><h2>Navigering som ska bort</h2></nav>
        <main>
            <h2>Kraftig brand i bostadshus i Bengtsfors</h2>
            <h2><a href="/nyheter/a/abc123/starmer">Starmers avgangsbesked vantas under morgonen</a></h2>
            <div class="post-title">Espriella vinner valet i Colombia</div>
            <h3>Kort</h3>
        </main>
    </body></html>`;
    const items = det.extractHeadlineItems(html, "https://ex.se/direkt", "2026-01-01T00:00:00Z");
    const titles = items.map((i) => i.title);
    assert.ok(titles.includes("Kraftig brand i bostadshus i Bengtsfors"), "keeps linkless post");
    assert.ok(titles.includes("Espriella vinner valet i Colombia"), "keeps title-class post");
    assert.ok(!titles.some((t) => /Navigering/.test(t)), "drops nav heading");
    assert.ok(!titles.includes("Kort"), "drops too-short scrap");
    const starmer = items.find((i) => /Starmers/.test(i.title));
    assert.ok(starmer && /abc123/.test(starmer.url || ""), "captures URL when the post links out");
});

test("extractHeadlineItems dedupes identical headlines (ticker shown twice)", () => {
    const html = `<main>
        <h2>Samma rubrik upprepas</h2>
        <div class="headline">Samma rubrik upprepas</div>
    </main>`;
    const items = det.extractHeadlineItems(html, "https://ex.se/direkt", "2026-01-01T00:00:00Z");
    assert.equal(items.filter((i) => i.title === "Samma rubrik upprepas").length, 1);
});

test("extractHeadlineItems strips trailing video duration and dedupes the pair", () => {
    const html = `<main>
        <h2>Varmevarning och alkoholforbud i Frankrike</h2>
        <figure class="title">Varmevarning och alkoholforbud i Frankrike1:01</figure>
    </main>`;
    const items = det.extractHeadlineItems(html, "https://ex.se/direkt", "2026-01-01T00:00:00Z");
    assert.equal(items.length, 1, "duration variant should collapse into one item");
    assert.equal(items[0].title, "Varmevarning och alkoholforbud i Frankrike");
});

test("extractJsonLdDates returns the newest date", () => {
    const html = `<script type="application/ld+json">
        {"@type":"NewsArticle","datePublished":"2026-05-01T10:00:00Z","dateModified":"2026-06-01T10:00:00Z"}
    </script>`;
    assert.equal(det.extractJsonLdDates(html), "2026-06-01T10:00:00.000Z");
});

test("normalizeTextFromHtml strips scripts and collapses whitespace", () => {
    const html = `<body><main>Hej <script>var x=1</script>   varld</main></body>`;
    assert.equal(det.normalizeTextFromHtml(html), "Hej varld");
});
