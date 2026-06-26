// Sources that are part of the core newsroom watch and must never be removed
// (the trash button is hidden in the UI and deletion is rejected server-side).
// Membership is matched by exact URL; this list is authoritative — it's synced
// onto the `is_permanent` flag on every startup.
const PERMANENT_SOURCE_URLS = [
    // --- National / large outlets ---
    "https://polisen.se/aktuellt/polisens-nyheter/?requestId=1679026730860&id=112673&lpfm.pid=0&lpfm.loc=&lpfm.srt=du",
    "https://www.sverigesradio.se/",
    "https://www.svd.se/",
    "https://www.dn.se/",
    "https://www.aftonbladet.se/",
    "https://www.expressen.se/",
    "https://www.tv4.se/",
    "https://via.tt.se/pressrum/3235540/aklagarmyndigheten",

    // --- Live "direkt" feeds ---
    "https://www.aftonbladet.se/nyheter/a/Rr77qd/aftonbladet-direkt",
    "https://www.expressen.se/nyheter/expressen-direkt/",
    "https://www.tv4.se/just-nu",
    "https://www.svd.se/a/wA9Gmd/senaste-nytt",
    "https://www.dn.se/direkt/",
];

module.exports = { PERMANENT_SOURCE_URLS };
