// A "space" is a lightweight, account-less identity (a person's name/initials)
// used to keep each colleague's personal sources separate. Normalised so that
// "Anna B", "anna b" and "  ANNA   B " all map to the same space key.
function normalizeSpace(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 60);
}

module.exports = { normalizeSpace };
