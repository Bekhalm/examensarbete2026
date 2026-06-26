const crypto = require("crypto");
const config = require("./config");

const COOKIE_NAME = "nm_user";

// A username is a self-chosen label, not a secret. We keep a canonical form
// (lowercased, whitespace-collapsed) as the identity key that scopes a person's
// sources, and a display form (as typed, trimmed) for the UI.
function normalizeUsername(raw) {
    const display = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return { display, canonical: display.toLowerCase() };
}

function isValidUsername(display) {
    // Letters (incl. åäö etc.), digits, space, dot, dash, underscore.
    return display.length >= 2 && /^[\p{L}\p{N} ._-]+$/u.test(display);
}

// Constant-time comparison so the shared password can't be guessed by timing.
function passwordMatches(candidate) {
    if (!config.accessPassword) return false;
    const a = Buffer.from(String(candidate || ""));
    const b = Buffer.from(config.accessPassword);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

const cookieOptions = {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: config.sessionMaxAgeMs,
    // `secure` is set per-request based on the connection, so it works on both
    // http://localhost and an https deployment.
};

function setSession(res, canonical, req) {
    res.cookie(COOKIE_NAME, canonical, {
        ...cookieOptions,
        secure: !!(req && req.secure),
    });
}

function clearSession(res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax" });
}

// Reads the signed cookie and attaches req.owner (canonical username) when a
// valid session exists. When auth is disabled, everyone shares a single
// null-owner space.
function resolveUser(req, _res, next) {
    if (!config.authEnabled) {
        req.owner = null;
        next();
        return;
    }
    const canonical = req.signedCookies && req.signedCookies[COOKIE_NAME];
    req.owner = canonical && typeof canonical === "string" ? canonical : null;
    next();
}

// Blocks API access until logged in (only when auth is enabled).
function requireAuth(req, res, next) {
    if (!config.authEnabled || req.owner) {
        next();
        return;
    }
    res.status(401).json({ error: "Inte inloggad" });
}

module.exports = {
    COOKIE_NAME,
    normalizeUsername,
    isValidUsername,
    passwordMatches,
    setSession,
    clearSession,
    resolveUser,
    requireAuth,
};
