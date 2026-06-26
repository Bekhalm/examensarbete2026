// =====================
// State
// =====================
let notificationsEnabled = false;
let isRendering = false;
let latestAlertSourceId = null;
let currentUser = null; // logged-in display name (null when not logged in)
let authRequired = false; // server has a password configured
const alerts = loadAlerts(); // [{ name, url, at }]
const recentAlertKeys = new Map(); // de-dupe local vs SSE alerts

// "Bevakningar": the current user's personal source groups. mutedSourceIds is
// derived from them (sources filed into a notify=0 group) and is used to hide
// those larm from the feed instantly when a group is muted.
let groups = [];
let groupsById = new Map();
let mutedSourceIds = new Set();

// Drag-and-drop: which source is being dragged and which bevakning it came from.
let dragSourceId = null;
let dragSourceGroup = null;

// =====================
// Helpers
// =====================
function $(id) {
    return document.getElementById(id);
}
function pad(n) {
    return String(n).padStart(2, "0");
}
function formatAbsolute(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("sv-SE", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
}
function timeAgo(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 45) return "nyss";
    if (s < 3600) return `${Math.floor(s / 60)} min sedan`;
    if (s < 86400) return `${Math.floor(s / 3600)} tim sedan`;
    return `${Math.floor(s / 86400)} d sedan`;
}
function timeUntil(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const s = (d.getTime() - Date.now()) / 1000;
    if (s <= 5) return "när som helst";
    if (s < 60) return `om ${Math.round(s)}s`;
    if (s < 3600) return `om ${Math.round(s / 60)} min`;
    return `om ${Math.round(s / 3600)} tim`;
}
function heartbeatText(checkedIso, nextIso, active) {
    if (!active) return "pausad – bevakas inte";
    const ago = timeAgo(checkedIso);
    const next = timeUntil(nextIso);
    if (!ago) return next ? `kontrollerar ${next}` : "väntar på första kontroll…";
    return `⟳ kontrollerad ${ago}${next ? ` · nästa ${next}` : ""}`;
}
function isToday(iso) {
    if (!iso) return false;
    return new Date(iso).toDateString() === new Date().toDateString();
}
function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}
function loadAlerts() {
    try {
        return JSON.parse(localStorage.getItem("nm_alerts") || "[]");
    } catch {
        return [];
    }
}
function saveAlerts() {
    try {
        localStorage.setItem("nm_alerts", JSON.stringify(alerts.slice(0, 50)));
    } catch {
        /* ignore */
    }
}

// =====================
// Live clock
// =====================
function tickClock() {
    const d = new Date();
    $("clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
setInterval(tickClock, 1000);
tickClock();

// =====================
// Sound + notifications
// =====================
let audioCtx = null;
// Browsers keep audio "locked" until the user interacts with the page at least
// once per load. Permission can be granted yet sound still won't play, so we
// track the unlocked state separately and reflect it in the button.
let audioReady = false;
function markAudioReady() {
    if (!audioReady && audioCtx && audioCtx.state === "running") {
        audioReady = true;
        updateNotifUi();
    }
}
function ensureAudio() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch {
            return;
        }
    }
    if (audioCtx.state === "suspended") {
        audioCtx.resume().then(markAudioReady).catch(() => { /* blocked until a gesture */ });
    } else {
        markAudioReady();
    }
}
// Browsers block audio until the user interacts with the page at least once.
// Quietly arm the sound on the first interaction so beeps work without needing
// the "Aktivera notiser" button to be re-clicked every reload.
document.addEventListener("pointerdown", ensureAudio);
document.addEventListener("keydown", ensureAudio);

// Notification volume (0–1), adjustable and remembered across reloads.
let notifVolume = parseFloat(localStorage.getItem("nm_volume"));
if (Number.isNaN(notifVolume)) notifVolume = 0.5;
notifVolume = Math.min(1, Math.max(0, notifVolume));
let lastNonZeroVolume = notifVolume > 0 ? notifVolume : 0.5;
const MAX_BEEP_GAIN = 1.0; // full-slider loudness (compressor keeps it clean)

function volumeIcon(v) {
    if (v <= 0) return "🔇";
    if (v < 0.34) return "🔈";
    if (v < 0.67) return "🔉";
    return "🔊";
}
function syncVolumeUi() {
    const slider = $("volSlider");
    const btn = $("volBtn");
    if (slider) slider.value = String(Math.round(notifVolume * 100));
    if (btn) {
        btn.textContent = volumeIcon(notifVolume);
        btn.title = notifVolume <= 0 ? "Ljud av" : `Volym ${Math.round(notifVolume * 100)}%`;
    }
}
function setVolume(v, { preview = false } = {}) {
    notifVolume = Math.min(1, Math.max(0, v));
    if (notifVolume > 0) lastNonZeroVolume = notifVolume;
    try { localStorage.setItem("nm_volume", String(notifVolume)); } catch { /* ignore */ }
    syncVolumeUi();
    if (preview && notifVolume > 0) { ensureAudio(); previewBeep(); }
}

// Shared output through a compressor so the chime is loud and present without
// clipping/harshness, even with several notes overlapping at high volume.
let audioBus = null;
function audioOut() {
    if (!audioBus) {
        // Gentle limiting (so it never clips/distorts) + makeup gain for loudness.
        const comp = audioCtx.createDynamicsCompressor();
        comp.threshold.value = -10;
        comp.knee.value = 20;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.2;
        const makeup = audioCtx.createGain();
        makeup.gain.value = 2.4;
        comp.connect(makeup);
        makeup.connect(audioCtx.destination);
        audioBus = comp;
    }
    return audioBus;
}

// Signature alert: a single short, clean "ping" — one bright sine note (~1180 Hz)
// with a quick decay (~0.16s). Volume-scaled so it can be turned up.
function playChime() {
    const peak = Math.max(0.0002, notifVolume * MAX_BEEP_GAIN);
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioOut());
    o.type = "sine";
    const t = audioCtx.currentTime;
    o.frequency.setValueAtTime(1180, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.start(t);
    o.stop(t + 0.18);
}
function beep() {
    if (notifVolume <= 0) return;
    ensureAudio();
    if (!audioCtx) return;
    // The context is often suspended (tab was backgrounded / no recent gesture);
    // wait for resume() before scheduling notes, otherwise the chime is dropped.
    if (audioCtx.state === "suspended") {
        audioCtx.resume().then(playChime).catch(() => { /* blocked until a gesture */ });
    } else {
        playChime();
    }
}

// Volume preview while dragging the slider — same pleasant chime.
function previewBeep() {
    beep();
}
function notify(title, body) {
    if (!notificationsEnabled || !("Notification" in window)) return;
    try {
        new Notification(title, { body });
    } catch {
        /* ignore */
    }
}
const NOTIF_DISABLED_KEY = "nm_notif_disabled";
function notifDisabledByUser() {
    try { return localStorage.getItem(NOTIF_DISABLED_KEY) === "1"; } catch { return false; }
}
function setNotifDisabledFlag(off) {
    try {
        if (off) localStorage.setItem(NOTIF_DISABLED_KEY, "1");
        else localStorage.removeItem(NOTIF_DISABLED_KEY);
    } catch { /* ignore */ }
}
// One button, two states: turn notifications on (ask permission + subscribe) or
// off (unsubscribe from this device so the server stops pushing to it).
async function toggleNotifications() {
    ensureAudio();
    if (notificationsEnabled) {
        await disableNotifications();
        return;
    }
    let perm = "granted";
    if ("Notification" in window) perm = await Notification.requestPermission();
    notificationsEnabled = perm === "granted";
    if (notificationsEnabled) {
        setNotifDisabledFlag(false);
        beep(); // instant feedback that sound works (also unlocks audio this load)
        registerPush();
    }
    updateNotifUi();
}
async function disableNotifications() {
    notificationsEnabled = false;
    setNotifDisabledFlag(true);
    await unregisterPush();
    updateNotifUi();
}
function updateNotifUi() {
    const btn = $("enableNotifs");
    if (!btn) return;
    btn.hidden = false;
    const status = $("notifStatus");
    if (status) status.classList.remove("warn", "ok", "bad");
    const denied = "Notification" in window && Notification.permission === "denied";
    if (notificationsEnabled) {
        btn.innerHTML = '<span class="bell">🔔</span> Notiser på · klicka för att stänga av';
        btn.classList.add("on");
        btn.classList.remove("needs-action");
        btn.title = "Notiser och ljud är på. Klicka för att stänga av notiser på den här enheten.";
        if (status) status.textContent = "";
    } else if (denied) {
        btn.innerHTML = '<span class="bell">🔕</span> Notiser blockerade';
        btn.classList.remove("on", "needs-action");
        btn.title = "Tillåt notiser i webbläsarens inställningar för att få larm.";
        if (status) { status.textContent = "Blockerade i webbläsaren"; status.classList.add("bad"); }
    } else {
        btn.innerHTML = '<span class="bell">🔔</span> Aktivera ljud & notiser';
        btn.classList.add("needs-action");
        btn.classList.remove("on");
        btn.title = "Klicka här för att slå på ljud och banner-notiser – annars får du inga larm.";
        if (status) { status.textContent = "← Klicka för att få larm"; status.classList.add("warn"); }
    }
}
// On load: re-enable automatically only if the browser still grants permission
// AND the user hasn't explicitly turned notifications off here before.
function initNotifications() {
    if (!notifDisabledByUser() && "Notification" in window && Notification.permission === "granted") {
        notificationsEnabled = true;
        registerPush();
    }
    updateNotifUi();
}
$("enableNotifs").addEventListener("click", toggleNotifications);

// Volume control: slider sets level (with a quick preview beep), speaker toggles mute.
(function initVolumeControls() {
    const slider = $("volSlider");
    const btn = $("volBtn");
    if (slider) {
        slider.addEventListener("input", () => setVolume(Number(slider.value) / 100));
        slider.addEventListener("change", () => setVolume(Number(slider.value) / 100, { preview: true }));
    }
    if (btn) {
        btn.addEventListener("click", () => {
            if (notifVolume > 0) setVolume(0);
            else setVolume(lastNonZeroVolume || 0.5, { preview: true });
        });
    }
    syncVolumeUi();
})();

// Theme: dark (default) / light, remembered across reloads.
(function initTheme() {
    const KEY = "nm_theme";
    const btn = $("themeToggle");
    const apply = (theme) => {
        document.documentElement.dataset.theme = theme;
        if (btn) {
            btn.textContent = theme === "light" ? "☀️" : "🌙";
            btn.title = theme === "light" ? "Byt till mörkt tema" : "Byt till ljust tema";
        }
    };
    let saved = "dark";
    try { saved = localStorage.getItem(KEY) || "dark"; } catch { /* ignore */ }
    apply(saved === "light" ? "light" : "dark");
    if (btn) {
        btn.addEventListener("click", () => {
            const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
            apply(next);
            try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
        });
    }
})();

// =====================
// Web Push
// =====================
function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function registerPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let info;
    try {
        info = await fetch("/api/push/key").then((r) => r.json());
    } catch {
        return;
    }
    if (!info.enabled || !info.publicKey) return;
    try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(info.publicKey),
        });
        await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription: sub }),
        });
    } catch (err) {
        console.warn("Push registration failed:", err);
    }
}
// Tear down this device's push subscription and tell the server to forget it,
// so it stops pushing here even when the tab is closed.
async function unregisterPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
        const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
        const sub = reg && (await reg.pushManager.getSubscription());
        if (!sub) return;
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => { /* ignore */ });
        await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint }),
        }).catch(() => { /* ignore */ });
    } catch (err) {
        console.warn("Push unsubscribe failed:", err);
    }
}

// =====================
// Toasts
// =====================
function toast(title, body, emoji = "🚨") {
    const wrap = $("toastWrap");
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span class="toast-emoji"></span><div><div class="toast-title"></div><div class="toast-body"></div></div>`;
    el.querySelector(".toast-emoji").textContent = emoji;
    el.querySelector(".toast-title").textContent = title;
    el.querySelector(".toast-body").textContent = body;
    wrap.appendChild(el);
    setTimeout(() => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 320);
    }, 6000);
}

// =====================
// API
// =====================
// Wrap fetch so an expired/missing session (401) drops the user back to the
// login screen instead of silently failing.
async function apiFetch(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
        showLogin();
        throw new Error("Inte inloggad");
    }
    return res;
}
async function fetchSources() {
    const res = await apiFetch("/api/sources");
    if (!res.ok) throw new Error("Kunde inte hämta källor");
    return res.json();
}
async function toggleSource(id, isActive) {
    const res = await apiFetch(`/api/sources/${id}/toggle`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte ändra källa");
}
async function addSource(payload) {
    const res = await apiFetch("/api/sources", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data.details && data.details.join(", ")) || data.error || "Kunde inte lägga till källa");
    }
    return res.json();
}
async function removeSource(id) {
    const res = await apiFetch(`/api/sources/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte ta bort källa");
}
async function fetchHistory(id) {
    const res = await apiFetch(`/api/sources/${id}/history`);
    if (!res.ok) throw new Error("Kunde inte hämta historik");
    return res.json();
}
async function fetchGroups() {
    const res = await apiFetch("/api/groups");
    if (!res.ok) throw new Error("Kunde inte hämta mappar");
    return res.json();
}
async function createGroup(name) {
    const res = await apiFetch("/api/groups", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte skapa mapp");
    return res.json();
}
async function patchGroup(id, fields) {
    const res = await apiFetch(`/api/groups/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte uppdatera mapp");
}
async function deleteGroup(id) {
    const res = await apiFetch(`/api/groups/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte ta bort mapp");
    return res.json().catch(() => ({}));
}
async function assignSourceGroup(id, groupId) {
    const res = await apiFetch(`/api/sources/${id}/group`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Kunde inte gruppera källa");
}

// =====================
// Render
// =====================
function buildFavicon(url, name) {
    const host = hostOf(url);
    if (host) {
        const img = document.createElement("img");
        img.className = "favicon";
        img.alt = "";
        img.loading = "lazy";
        img.src = `/api/favicon?domain=${encodeURIComponent(host)}`;
        img.addEventListener("error", () => img.replaceWith(makeFaviconFallback(name)));
        return img;
    }
    return makeFaviconFallback(name);
}
function makeFaviconFallback(name) {
    const fb = document.createElement("div");
    fb.className = "favicon favicon-fallback";
    fb.textContent = (name || "?").trim().charAt(0).toUpperCase();
    return fb;
}

// Status pill reflects ONLY on/off state (Aktiv/Pausad). Fetch errors are
// shown separately as a small warning badge so a temporary blip doesn't make
// a source look "broken".
function statusPill(s) {
    const pill = document.createElement("span");
    if (s.is_active === 1) {
        pill.className = "pill active";
        pill.innerHTML = `<span class="dot"></span>Aktiv`;
    } else {
        pill.className = "pill paused";
        pill.innerHTML = `<span class="dot"></span>Pausad`;
    }
    return pill;
}

// Only flag a source as troubled after repeated failures — a single transient
// blip (which clears on the next successful check) shouldn't litter the table.
const FAIL_THRESHOLD = 3;

function statusCell(s) {
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "status-cell";
    wrap.appendChild(statusPill(s));
    if (s.consecutive_failures >= FAIL_THRESHOLD && s.last_error) {
        const chip = document.createElement("span");
        chip.className = "fail-chip";
        chip.textContent = "Svarar inte";
        chip.title = `Misslyckats ${s.consecutive_failures} gånger i rad: ${s.last_error}`;
        wrap.appendChild(chip);
    }
    td.appendChild(wrap);
    return td;
}

function timeCell(iso, tooltipLabel) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    const rel = timeAgo(iso);
    if (!rel) {
        span.className = "time-cell time-dash";
        span.textContent = "—";
    } else {
        span.className = "time-cell" + (isToday(iso) ? " fresh" : "");
        span.textContent = rel;
        span.title = tooltipLabel ? `${tooltipLabel}: ${formatAbsolute(iso)}` : formatAbsolute(iso);
    }
    td.appendChild(span);
    return td;
}

// ----- Drag-and-drop between bevakningar -----
function clearDropHighlight() {
    const body = $("sourcesBody");
    if (body) body.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
}
// Highlight every row of the bevakning currently under the cursor.
function highlightGroup(gid) {
    clearDropHighlight();
    const body = $("sourcesBody");
    if (!body) return;
    body.querySelectorAll(`tr[data-group-id="${CSS.escape(gid)}"]`).forEach((tr) => tr.classList.add("drop-target"));
}
let dropZoneReady = false;
function setupDropZone() {
    if (dropZoneReady) return;
    const body = $("sourcesBody");
    if (!body) return;
    dropZoneReady = true;

    body.addEventListener("dragover", (e) => {
        if (dragSourceId == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const row = e.target.closest("tr");
        if (!row || row.dataset.groupId === undefined) { clearDropHighlight(); return; }
        highlightGroup(row.dataset.groupId || "");
    });
    body.addEventListener("drop", async (e) => {
        if (dragSourceId == null) return;
        e.preventDefault();
        const row = e.target.closest("tr");
        clearDropHighlight();
        if (!row || row.dataset.groupId === undefined) return;
        const targetGid = row.dataset.groupId || "";
        const sid = dragSourceId;
        if ((dragSourceGroup || "") === targetGid) return; // dropped where it already was
        try {
            await assignSourceGroup(sid, targetGid ? Number(targetGid) : null);
            await render();
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        }
    });
}

function renderRow(s) {
    const tr = document.createElement("tr");
    if (s.is_active === 0) tr.classList.add("inactive");
    if (latestAlertSourceId === s.id) tr.classList.add("flash");
    // Tag the row so drag-and-drop knows which bevakning it currently sits in.
    tr.dataset.sourceId = String(s.id);
    tr.dataset.groupId = s.group_id != null ? String(s.group_id) : "";

    tr.appendChild(statusCell(s));

    const tdSource = document.createElement("td");
    const cell = document.createElement("div");
    cell.className = "source-cell";
    // Drag handle (only useful once there are bevakningar to drag between).
    if (groups.length) {
        const handle = document.createElement("span");
        handle.className = "drag-handle";
        handle.textContent = "⠿";
        handle.title = "Dra för att flytta till en annan mapp";
        handle.draggable = true;
        handle.addEventListener("dragstart", (e) => {
            dragSourceId = s.id;
            dragSourceGroup = tr.dataset.groupId || "";
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(s.id));
            try { e.dataTransfer.setDragImage(tr, 12, 12); } catch { /* ignore */ }
            tr.classList.add("dragging");
        });
        handle.addEventListener("dragend", () => {
            dragSourceId = null;
            dragSourceGroup = null;
            tr.classList.remove("dragging");
            clearDropHighlight();
        });
        cell.appendChild(handle);
    }
    cell.appendChild(buildFavicon(s.url, s.name));
    const meta = document.createElement("div");
    meta.className = "source-meta";
    const nm = document.createElement("button");
    nm.className = "source-name linkish";
    nm.textContent = s.name || "(namnlös)";
    nm.title = "Visa historik";
    nm.addEventListener("click", () => openHistory(s));
    const a = document.createElement("a");
    a.className = "source-url";
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = s.extract_mode === "ticker" ? `⚡ ${s.url}` : (s.feed_url ? `📡 ${s.feed_url}` : s.url);
    const hb = document.createElement("div");
    hb.className = "heartbeat";
    hb.dataset.checked = s.last_checked_at || "";
    hb.dataset.next = s.next_check_at || "";
    hb.dataset.active = s.is_active === 1 ? "1" : "0";
    hb.textContent = heartbeatText(s.last_checked_at, s.next_check_at, s.is_active === 1);
    meta.appendChild(nm);
    meta.appendChild(a);
    meta.appendChild(hb);
    // Let the user file this source into one of their bevakningar. Only shown
    // once they actually have a group to file it into.
    if (groups.length) {
        const pick = document.createElement("div");
        pick.className = "group-pick";
        const lbl = document.createElement("span");
        lbl.className = "group-pick-label";
        lbl.textContent = "🗂 Mapp:";
        const gsel = document.createElement("select");
        gsel.className = "group-select";
        gsel.title = "Välj vilken mapp källan ligger i";
        gsel.appendChild(new Option("Ingen", ""));
        for (const g of groups) gsel.appendChild(new Option(g.name, String(g.id)));
        gsel.value = s.group_id != null ? String(s.group_id) : "";
        gsel.addEventListener("change", async () => {
            gsel.disabled = true;
            try {
                await assignSourceGroup(s.id, gsel.value ? Number(gsel.value) : null);
                await render();
            } catch (err) {
                toast("Fel", err.message, "⚠️");
                gsel.disabled = false;
            }
        });
        pick.append(lbl, gsel);
        meta.appendChild(pick);
    }
    cell.appendChild(meta);
    tdSource.appendChild(cell);
    tr.appendChild(tdSource);

    tr.appendChild(timeCell(s.last_notified_at, "Vi larmade"));

    const tdActions = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const label = document.createElement("label");
    label.className = "switch";
    label.title = s.is_active === 1 ? "Pausa kontroll av källan" : "Återuppta kontroll av källan";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.is_active === 1;
    cb.addEventListener("change", async () => {
        cb.disabled = true;
        try {
            await toggleSource(s.id, cb.checked);
            await render();
        } catch (err) {
            toast("Fel", err.message, "⚠️");
            cb.checked = !cb.checked;
            cb.disabled = false;
        }
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(cb);
    label.appendChild(slider);

    actions.appendChild(label);

    if (s.is_permanent) {
        // Core source: no delete button, just a lock so it reads as protected.
        const lock = document.createElement("span");
        lock.className = "perm-lock";
        lock.textContent = "🔒";
        lock.title = "Permanent källa – kan inte tas bort";
        actions.appendChild(lock);
    } else {
        const delBtn = document.createElement("button");
        delBtn.className = "icon-btn danger";
        delBtn.textContent = "🗑";
        delBtn.title = "Ta bort källa";
        delBtn.addEventListener("click", async () => {
            const ok = await confirmDialog({
                title: "Ta bort källa",
                message: `Vill du ta bort "${s.name}"? Källan och dess historik försvinner.`,
                okLabel: "Ta bort källa",
            });
            if (!ok) return;
            try {
                await removeSource(s.id);
                await render();
                toast("Källa borttagen", s.name, "🗑");
            } catch (err) {
                toast("Fel", err.message, "⚠️");
            }
        });
        actions.appendChild(delBtn);
    }
    tdActions.appendChild(actions);
    tr.appendChild(tdActions);

    return tr;
}

function groupHeaderRow(g) {
    const tr = document.createElement("tr");
    tr.className = "group-row" + (g.notify ? "" : " muted");
    tr.dataset.groupId = String(g.id);
    const td = document.createElement("td");
    td.colSpan = 4;
    const wrap = document.createElement("div");
    wrap.className = "group-head";

    const icon = document.createElement("span");
    icon.className = "group-icon";
    icon.textContent = "🗂";

    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = g.name;

    const spacer = document.createElement("span");
    spacer.className = "group-spacer";

    // Clearly labelled on/off button — the main action for a bevakning.
    const toggle = document.createElement("button");
    toggle.className = "group-toggle" + (g.notify ? " on" : " off");
    toggle.innerHTML = `<span class="gt-ico">${g.notify ? "🔔" : "🔕"}</span><span class="gt-text">${g.notify ? "Notiser på" : "Tystad"}</span>`;
    toggle.title = g.notify
        ? "Notiser på – klicka för att tysta hela mappen (du slutar få larm härifrån)"
        : "Tystad – klicka för att börja få larm härifrån igen";
    toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
            await patchGroup(g.id, { notify: !g.notify });
            await render();
        } catch (err) {
            toast("Fel", err.message, "⚠️");
            toggle.disabled = false;
        }
    });

    const rename = document.createElement("button");
    rename.className = "group-action";
    rename.textContent = "✏️";
    rename.title = "Byt namn på mappen";
    rename.addEventListener("click", async () => {
        const next = await openGroupModal({ title: "Byt namn på mapp", value: g.name });
        if (next == null || next === g.name) return;
        try {
            await patchGroup(g.id, { name: next });
            await render();
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        }
    });

    const del = document.createElement("button");
    del.className = "group-action danger";
    del.textContent = "🗑";
    del.title = "Ta bort mappen och dess källor";
    del.addEventListener("click", async () => {
        const ok = await confirmDialog({
            title: "Ta bort mapp",
            message: `Vill du ta bort mappen "${g.name}"?\n\nDina egna källor i mappen tas bort. Permanenta källor tas inte bort – de flyttas ut ur mappen.`,
            okLabel: "Ta bort mapp",
        });
        if (!ok) return;
        try {
            const res = await deleteGroup(g.id);
            await render();
            const n = res && res.deletedSources ? res.deletedSources : 0;
            const detail = n ? `${g.name} · ${n} ${n === 1 ? "källa" : "källor"} borttagna` : g.name;
            toast("Mapp borttagen", detail, "🗑");
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        }
    });

    wrap.append(icon, name, spacer, toggle, rename, del);
    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
}

function ungroupedHeaderRow() {
    const tr = document.createElement("tr");
    tr.className = "group-row ungrouped";
    tr.dataset.groupId = "";
    const td = document.createElement("td");
    td.colSpan = 4;
    const wrap = document.createElement("div");
    wrap.className = "group-head";
    const name = document.createElement("span");
    name.className = "group-name muted";
    name.textContent = "Permanenta källor";
    wrap.append(name);
    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
}

function renderSources(sources) {
    const tableEl = $("sourcesTable");
    const emptyEl = $("emptyState");
    const body = $("sourcesBody");
    if (!sources.length) {
        tableEl.hidden = true;
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;
    tableEl.hidden = false;
    setupDropZone();
    body.innerHTML = "";

    const sorted = sources
        .slice()
        .sort((a, b) => (b.last_notified_at || "").localeCompare(a.last_notified_at || ""));

    // No groups yet: keep the original flat list.
    if (!groups.length) {
        sorted.forEach((s) => body.appendChild(renderRow(s)));
        return;
    }

    const buckets = new Map(groups.map((g) => [g.id, []]));
    const ungrouped = [];
    for (const s of sorted) {
        if (s.group_id != null && buckets.has(s.group_id)) buckets.get(s.group_id).push(s);
        else ungrouped.push(s);
    }
    for (const g of groups) {
        body.appendChild(groupHeaderRow(g));
        for (const s of buckets.get(g.id)) {
            const row = renderRow(s);
            if (!g.notify) row.classList.add("in-muted-group");
            body.appendChild(row);
        }
    }
    if (ungrouped.length) {
        body.appendChild(ungroupedHeaderRow());
        for (const s of ungrouped) body.appendChild(renderRow(s));
    }
}

async function render() {
    if (isRendering) return;
    isRendering = true;
    try {
        const [sources, grps] = await Promise.all([fetchSources(), fetchGroups()]);
        groups = Array.isArray(grps) ? grps : [];
        groupsById = new Map(groups.map((g) => [g.id, g]));
        mutedSourceIds = new Set();
        for (const s of sources) {
            if (s.group_id != null) {
                const g = groupsById.get(s.group_id);
                if (g && !g.notify) mutedSourceIds.add(s.id);
            }
        }
        renderSources(sources);
        populateAddGroupSelect();
        // Reflect mute changes in the feed immediately.
        renderAlertLog();
    } catch (err) {
        console.error("Render error:", err);
    } finally {
        isRendering = false;
    }
}

// Keep the "Lägg till källa"-form's map picker in sync with the user's mappar.
// Hidden entirely until they have at least one map to file into.
function populateAddGroupSelect() {
    const field = $("addGroupField");
    const sel = $("addGroup");
    if (!field || !sel) return;
    const prev = sel.value;
    sel.innerHTML = "";
    sel.appendChild(new Option("🗂 Välj mapp", ""));
    for (const g of groups) sel.appendChild(new Option(g.name, String(g.id)));
    // Always offer an inline "create map" entry so a new källa can be filed into
    // a brand-new map without leaving the form.
    sel.appendChild(new Option("➕ Skapa ny mapp…", "__new__"));
    if (prev && groups.some((g) => String(g.id) === prev)) sel.value = prev;
    field.hidden = false;
}

// =====================
// History modal
// =====================
async function openHistory(s) {
    const modal = $("modal");
    const bodyEl = $("modalBody");
    $("modalTitle").textContent = `Historik — ${s.name}`;
    bodyEl.innerHTML = `<p class="muted">Laddar…</p>`;
    modal.hidden = false;
    try {
        const items = await fetchHistory(s.id);
        if (!items.length) {
            bodyEl.innerHTML = `<p class="muted">Inga upptäckta artiklar ännu.</p>`;
            return;
        }
        bodyEl.innerHTML = "";
        const list = document.createElement("ul");
        list.className = "history-list";
        items.forEach((it) => {
            const li = document.createElement("li");
            const t = document.createElement("div");
            t.className = "history-title";
            if (it.url) {
                const a = document.createElement("a");
                a.href = it.url;
                a.target = "_blank";
                a.rel = "noreferrer";
                a.textContent = it.title || it.url;
                t.appendChild(a);
            } else {
                t.textContent = it.title || "(utan titel)";
            }
            const meta = document.createElement("div");
            meta.className = "history-meta";
            meta.textContent = `Upptäckt: ${formatAbsolute(it.first_seen_at)}${it.published_at ? " · Publicerad: " + formatAbsolute(it.published_at) : ""}`;
            li.appendChild(t);
            li.appendChild(meta);
            list.appendChild(li);
        });
        bodyEl.appendChild(list);
    } catch (err) {
        bodyEl.innerHTML = `<p class="muted">Kunde inte hämta historik.</p>`;
    }
}
$("modal").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) $("modal").hidden = true;
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("modal").hidden = true;
});

// =====================
// Alerts
// =====================
function alertKey(id, at) {
    return `${id}:${Math.floor(new Date(at).getTime() / 3000)}`;
}
function addAlert(payload, { render = true } = {}) {
    const at = payload.at || payload.last_notified_at || new Date().toISOString();
    const key = alertKey(payload.id, at);
    if (recentAlertKeys.has(key)) return false;
    recentAlertKeys.set(key, Date.now());
    if (recentAlertKeys.size > 200) recentAlertKeys.clear();

    alerts.unshift({ id: payload.id, name: payload.name, url: payload.url, at, title: payload.latest_item_title || null, articleUrl: payload.latest_item_url || null });
    latestAlertSourceId = payload.id;
    saveAlerts();
    if (render) {
        renderAlertLog();
        scheduleSeen();
    }
    return true;
}

// Merge a batch of recent alerts received on (re)connect, de-duped against
// what's already shown, then render once. The very first batch (page-load
// catch-up) is silent; later batches mean the live stream dropped and
// reconnected, so we ping once for any larm missed during the gap.
let firstBackfillDone = false;
function backfillAlerts(list) {
    let newCount = 0;
    if (Array.isArray(list)) {
        // Oldest-first so the newest ends up at the top after each unshift.
        for (const p of list) {
            if (addAlert(p, { render: false })) newCount++;
        }
    }
    if (newCount) {
        renderAlertLog();
        scheduleSeen();
        if (firstBackfillDone && notificationsEnabled) {
            beep();
            toast("Nya larm", `${newCount} larm medan anslutningen var nere`, "🚨");
        }
    }
    firstBackfillDone = true;
}

// Polling fallback: the live SSE stream is buffered by some proxies/tunnels
// (e.g. the free Cloudflare tunnel), so we also poll for recent alerts. This
// keeps the Larmflöde reliable everywhere. De-dup means it never doubles up
// with the live stream; it pings once for genuinely new larm (after the first
// silent catch-up).
let firstPollDone = false;
async function pollAlerts() {
    if (!currentUser && authRequired) return;
    try {
        const res = await apiFetch("/api/alerts");
        if (!res.ok) return;
        const list = await res.json();
        if (!Array.isArray(list)) return;
        let newCount = 0;
        for (const p of list) {
            if (addAlert(p, { render: false })) newCount++;
        }
        if (newCount) {
            renderAlertLog();
            scheduleSeen();
            if (firstPollDone && notificationsEnabled) {
                beep();
                toast("Nya larm", `${newCount} ${newCount === 1 ? "nytt larm" : "nya larm"}`, "🚨");
            }
        }
        setLive(true);
        firstPollDone = true;
    } catch {
        /* ignore */
    }
}
// "Unread" alerts glow green so you can see where to look when you come back —
// regardless of how long you were away. They clear a short, calm moment after
// the feed is actually in view (tab visible), then settle to a normal red dot.
// Baselined to "now" on first load so old history never shows up as a backlog.
let lastSeenAlertAt = localStorage.getItem("nm_alerts_seen") || "";
if (!lastSeenAlertAt) {
    lastSeenAlertAt = new Date().toISOString();
    try { localStorage.setItem("nm_alerts_seen", lastSeenAlertAt); } catch { /* ignore */ }
}
const SEEN_GRACE_MS = 30_000;
let seenTimer = null;

function isUnread(at) {
    return !!at && at > lastSeenAlertAt;
}

// Surface unread alerts in the browser tab itself, so you notice new larm even
// when you're working in another tab.
const BASE_TITLE = document.title;
function updateTabTitle() {
    const unread = alerts.reduce((n, a) => n + (isUnread(a.at) && !mutedSourceIds.has(a.id) ? 1 : 0), 0);
    document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

function renderAlertLog() {
    updateTabTitle();
    const log = $("alertLog");
    // Hide larm from sources the user has filed into a muted bevakning.
    const visible = alerts.filter((a) => !mutedSourceIds.has(a.id));
    if (!visible.length) {
        log.innerHTML = `<li class="alert-empty">Inga larm sedan start. Det dyker upp här direkt.</li>`;
        return;
    }
    log.innerHTML = "";
    visible.slice(0, 50).forEach((a) => {
        const li = document.createElement("li");
        li.className = "alert-item" + (isUnread(a.at) ? " new" : "");
        li.innerHTML = `<span class="marker"></span><div><div class="alert-title"></div><div class="alert-sub"></div><div class="alert-time"></div></div>`;
        li.querySelector(".alert-title").textContent = a.name || "Källa";
        const sub = li.querySelector(".alert-sub");
        const text = a.title || "Uppdatering upptäckt";
        // Prefer the specific article URL; fall back to the source's own page so
        // the alert is always clickable (e.g. Polisen folds items into accordions
        // without a per-item link).
        const href = a.articleUrl || a.url;
        if (href) {
            const link = document.createElement("a");
            link.className = "alert-link";
            link.href = href;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = text;
            link.title = a.articleUrl ? "Öppna artikeln" : "Öppna källan";
            sub.appendChild(link);
        } else {
            sub.textContent = text;
        }
        li.querySelector(".alert-time").textContent = formatAbsolute(a.at);
        log.appendChild(li);
    });
}

// Mark everything currently shown as seen (green markers fade to red).
function markAlertsSeen() {
    const newest = alerts[0] && alerts[0].at;
    if (!newest || newest <= lastSeenAlertAt) return;
    lastSeenAlertAt = new Date().toISOString();
    try { localStorage.setItem("nm_alerts_seen", lastSeenAlertAt); } catch { /* ignore */ }
    renderAlertLog();
}

// Only count the feed as "looked at" once the tab is actually visible, then
// give it a grace period so the green has time to register before it clears.
// A pending timer is never pushed back by new alerts — otherwise a busy live
// ticker would keep resetting it and the unread count would never clear while
// the page is open.
function scheduleSeen() {
    if (document.hidden) return;
    if (seenTimer) return;
    seenTimer = setTimeout(() => {
        seenTimer = null;
        markAlertsSeen();
    }, SEEN_GRACE_MS);
}

function handleAlert(payload, { sound = true } = {}) {
    const added = addAlert(payload);
    if (!added) return;
    render();
    // The Larmflöde always updates above; sound + toast + OS banner only fire
    // when the user has notifications switched on.
    if (!notificationsEnabled) return;
    if (sound) beep();
    const title = payload.name || "Källa";
    const body = payload.latest_item_title || "Uppdatering upptäckt";
    toast(title, body, "🚨");
    notify(title, body);
}

// =====================
// SSE live connection
// =====================
function setLive(connected) {
    const badge = document.querySelector(".badge-live");
    if (!badge) return;
    badge.textContent = connected ? "● LIVE" : "○ OFFLINE";
    badge.classList.toggle("offline", !connected);
}
let streamConn = null;
function connectStream() {
    if (streamConn) { try { streamConn.close(); } catch { /* ignore */ } }
    const es = new EventSource("/api/stream");
    streamConn = es;
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("backfill", (e) => {
        try {
            backfillAlerts(JSON.parse(e.data));
        } catch {
            /* ignore */
        }
    });
    es.addEventListener("alert", (e) => {
        try {
            handleAlert(JSON.parse(e.data));
        } catch {
            /* ignore */
        }
    });
    es.addEventListener("sources-changed", () => render());
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
}

// =====================
// Bevakningar (source groups)
// =====================
// In-app modal (matches the login UI) for naming/renaming a bevakning. Resolves
// to the trimmed name, or null if the user cancels.
function openGroupModal({ title, value = "" }) {
    return new Promise((resolve) => {
        const gate = $("groupModal");
        const form = $("groupForm");
        const input = $("groupName");
        const err = $("groupModalError");
        $("groupModalTitle").textContent = title;
        err.hidden = true;
        input.value = value;
        gate.hidden = false;
        setTimeout(() => { input.focus(); input.select(); }, 30);

        function cleanup() {
            gate.hidden = true;
            form.removeEventListener("submit", onSubmit);
            $("groupCancel").removeEventListener("click", onCancel);
            gate.removeEventListener("mousedown", onBackdrop);
            document.removeEventListener("keydown", onKey);
        }
        function onSubmit(e) {
            e.preventDefault();
            const v = input.value.trim();
            if (!v) { err.textContent = "Ange ett namn"; err.hidden = false; return; }
            cleanup();
            resolve(v);
        }
        function onCancel() { cleanup(); resolve(null); }
        function onBackdrop(e) { if (e.target === gate) { cleanup(); resolve(null); } }
        function onKey(e) { if (e.key === "Escape") { cleanup(); resolve(null); } }

        form.addEventListener("submit", onSubmit);
        $("groupCancel").addEventListener("click", onCancel);
        gate.addEventListener("mousedown", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

// Shared confirmation dialog (same card style as login/maps), replacing the
// browser's native confirm() so every popup looks the same. Resolves true/false.
function confirmDialog({ title = "Bekräfta", message = "", okLabel = "Ta bort", cancelLabel = "Avbryt" }) {
    return new Promise((resolve) => {
        const gate = $("confirmModal");
        const ok = $("confirmOk");
        const cancel = $("confirmCancel");
        $("confirmTitle").textContent = title;
        $("confirmText").textContent = message;
        ok.textContent = okLabel;
        cancel.textContent = cancelLabel;
        gate.hidden = false;
        setTimeout(() => ok.focus(), 30);

        function cleanup() {
            gate.hidden = true;
            ok.removeEventListener("click", onOk);
            cancel.removeEventListener("click", onCancel);
            gate.removeEventListener("mousedown", onBackdrop);
            document.removeEventListener("keydown", onKey);
        }
        function onOk() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        function onBackdrop(e) { if (e.target === gate) { cleanup(); resolve(false); } }
        function onKey(e) {
            if (e.key === "Escape") { cleanup(); resolve(false); }
            else if (e.key === "Enter") { cleanup(); resolve(true); }
        }

        ok.addEventListener("click", onOk);
        cancel.addEventListener("click", onCancel);
        gate.addEventListener("mousedown", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

// Step 2 of creating a map: pick which existing källor to file into it. Shows a
// checkbox list of the user's sources (same card style as the other popups).
// Resolves when the user saves, skips, or dismisses.
function openAddSourcesModal(group, sources) {
    return new Promise((resolve) => {
        const gate = $("addSourcesModal");
        const list = $("addSourcesList");
        const saveBtn = $("addSourcesSave");
        const skipBtn = $("addSourcesSkip");
        $("addSourcesTitle").textContent = `Lägg till källor i “${group.name}”`;

        // Ungrouped sources first, then alphabetical, so the obvious candidates
        // are at the top.
        const items = sources.slice().sort((a, b) => {
            const ag = a.group_id == null ? 0 : 1;
            const bg = b.group_id == null ? 0 : 1;
            if (ag !== bg) return ag - bg;
            return (a.name || "").localeCompare(b.name || "", "sv");
        });
        list.innerHTML = "";
        for (const s of items) {
            const label = document.createElement("label");
            label.className = "pick-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = String(s.id);
            const name = document.createElement("span");
            name.className = "pick-name";
            name.textContent = s.name;
            const meta = document.createElement("span");
            meta.className = "pick-host";
            if (s.group_id != null && s.group_id !== group.id) {
                const g = groupsById.get(s.group_id);
                meta.textContent = g ? `i ${g.name}` : "";
            } else {
                meta.textContent = hostOf(s.url) || "";
            }
            label.append(cb, name, meta);
            list.appendChild(label);
        }
        gate.hidden = false;

        function cleanup() {
            gate.hidden = true;
            saveBtn.removeEventListener("click", onSave);
            skipBtn.removeEventListener("click", onSkip);
            gate.removeEventListener("mousedown", onBackdrop);
            document.removeEventListener("keydown", onKey);
        }
        async function onSave() {
            const ids = Array.from(list.querySelectorAll("input:checked")).map((c) => Number(c.value));
            cleanup();
            let n = 0;
            for (const id of ids) {
                try { await assignSourceGroup(id, group.id); n += 1; } catch { /* ignore */ }
            }
            if (n) toast("Källor tillagda", `${n} ${n === 1 ? "källa" : "källor"} i ${group.name}`, "🗂");
            resolve();
        }
        function onSkip() { cleanup(); resolve(); }
        function onBackdrop(e) { if (e.target === gate) { cleanup(); resolve(); } }
        function onKey(e) { if (e.key === "Escape") { cleanup(); resolve(); } }

        saveBtn.addEventListener("click", onSave);
        skipBtn.addEventListener("click", onSkip);
        gate.addEventListener("mousedown", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

const newGroupBtn = $("newGroupBtn");
if (newGroupBtn) {
    newGroupBtn.addEventListener("click", async () => {
        const name = await openGroupModal({ title: "Ny mapp" });
        if (name == null) return;
        try {
            const created = await createGroup(name);
            toast("Mapp skapad", name, "🗂");
            // Next step: let them fill the new map with existing källor right away.
            let srcs = [];
            try { srcs = await fetchSources(); } catch { /* ignore */ }
            if (created && created.id && Array.isArray(srcs) && srcs.length) {
                await openAddSourcesModal(created, srcs);
            }
            await render();
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        }
    });
}

// =====================
// Add-source form
// =====================
$("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("formError");
    errEl.hidden = true;
    const name = $("name").value.trim();
    const url = $("url").value.trim();
    const groupSel = $("addGroup");
    let groupVal = groupSel ? groupSel.value : "";
    if (groupVal === "__new__") groupVal = ""; // sentinel, not a real map
    try {
        const created = await addSource({ name, url });
        // File it straight into the chosen map, if one was picked.
        if (groupVal) {
            try {
                await assignSourceGroup(created.id, Number(groupVal));
            } catch (assignErr) {
                toast("Obs", `Källan lades till men kunde inte läggas i mappen: ${assignErr.message}`, "⚠️");
            }
        }
        $("name").value = "";
        $("url").value = "";
        await render();
        const mapName = groupVal && groupsById.get(Number(groupVal)) ? groupsById.get(Number(groupVal)).name : null;
        const base = created.extract_mode === "ticker"
            ? `${name} bevakas som live-ticker`
            : created.feed_url ? `${name} (RSS hittades)` : `${name} bevakas nu`;
        const how = mapName ? `${base} · i mappen "${mapName}"` : base;
        toast("Källa tillagd", how, created.extract_mode === "ticker" ? "⚡" : "📡");
    } catch (err) {
        errEl.textContent = err.message || "Kunde inte lägga till källa";
        errEl.hidden = false;
    }
});

// Picking "Skapa ny mapp…" in the add-källa picker creates a map inline and
// selects it, so the källa you're adding lands straight in the new map.
const addGroupSel = $("addGroup");
if (addGroupSel) {
    addGroupSel.addEventListener("change", async () => {
        if (addGroupSel.value !== "__new__") return;
        addGroupSel.value = "";
        const name = await openGroupModal({ title: "Ny mapp" });
        if (name == null) return;
        try {
            const created = await createGroup(name);
            await render();
            if (created && created.id) addGroupSel.value = String(created.id);
            toast("Mapp skapad", name, "🗂");
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        }
    });
}
// Live heartbeat: update the "checked Xs ago · next in Ym" text in place every
// few seconds so each source visibly shows it's being watched.
function refreshHeartbeats() {
    document.querySelectorAll(".heartbeat").forEach((el) => {
        el.textContent = heartbeatText(el.dataset.checked || null, el.dataset.next || null, el.dataset.active === "1");
    });
}
setInterval(refreshHeartbeats, 5000);

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { ensureAudio(); scheduleSeen(); }
});
window.addEventListener("focus", () => { ensureAudio(); scheduleSeen(); });

// =====================
// Auth / login gate
// =====================
function showLogin() {
    const gate = $("loginGate");
    if (gate) gate.hidden = false;
    const ub = $("userBox");
    if (ub) ub.hidden = true;
    const u = $("loginUser");
    if (u) setTimeout(() => u.focus(), 30);
}
function hideLogin() {
    const gate = $("loginGate");
    if (gate) gate.hidden = true;
}
function setUser(username) {
    currentUser = username || null;
    const ub = $("userBox");
    const chip = $("userChip");
    if (username) {
        if (chip) chip.textContent = "👤 " + username;
        if (ub) ub.hidden = false;
        // If a different person last used this browser, drop the cached larm so
        // they don't briefly see someone else's feed (server backfill refills it).
        try {
            const last = localStorage.getItem("nm_last_user");
            if (last && last !== username) resetAlerts();
            localStorage.setItem("nm_last_user", username);
        } catch { /* ignore */ }
    } else if (ub) {
        ub.hidden = true;
    }
}
function resetAlerts() {
    alerts.length = 0;
    recentAlertKeys.clear();
    try {
        localStorage.removeItem("nm_alerts");
        localStorage.removeItem("nm_alerts_seen");
    } catch { /* ignore */ }
    renderAlertLog();
}
async function fetchMe() {
    try {
        const res = await fetch("/api/me");
        if (!res.ok) return { authEnabled: true, username: null };
        return res.json();
    } catch {
        return { authEnabled: true, username: null };
    }
}

const loginForm = $("loginForm");
if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = $("loginError");
        if (errEl) errEl.hidden = true;
        const username = $("loginUser").value.trim();
        const password = $("loginPass").value;
        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Inloggning misslyckades");
            setUser(data.username);
            $("loginPass").value = "";
            hideLogin();
            boot();
        } catch (err) {
            if (errEl) { errEl.textContent = err.message || "Inloggning misslyckades"; errEl.hidden = false; }
        }
    });
}
async function doLogout() {
    try { await fetch("/api/logout", { method: "POST" }); } catch { /* ignore */ }
    await unregisterPush().catch(() => { /* ignore */ });
    resetAlerts();
    try { localStorage.removeItem("nm_last_user"); } catch { /* ignore */ }
    location.reload();
}

// Clicking the username chip is the logout path (no separate button).
const userChip = $("userChip");
if (userChip) {
    userChip.addEventListener("click", async () => {
        const ok = await confirmDialog({
            title: "Logga ut",
            message: currentUser ? `Vill du logga ut som ${currentUser}?` : "Vill du logga ut?",
            okLabel: "Logga ut",
        });
        if (ok) await doLogout();
    });
}

// =====================
// Boot (after login)
// =====================
let booted = false;
function boot() {
    if (booted) return;
    booted = true;
    initNotifications();
    // Seed the de-dupe map from previously saved alerts so the reconnect
    // backfill doesn't duplicate larm already in the log.
    alerts.forEach((a) => recentAlertKeys.set(alertKey(a.id, a.at), Date.now()));
    renderAlertLog();
    scheduleSeen();
    render();
    connectStream();
    setInterval(render, 30000); // relative-time refresh (SSE handles real updates)
    pollAlerts();
    setInterval(pollAlerts, 10000); // reliable fallback if the live stream is buffered
}

(async function start() {
    const me = await fetchMe();
    authRequired = !!me.authEnabled;
    if (authRequired && !me.username) {
        showLogin();
        return;
    }
    setUser(me.username);
    hideLogin();
    boot();
})();
