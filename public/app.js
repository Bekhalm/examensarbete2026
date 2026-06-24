// =====================
// State
// =====================
let notificationsEnabled = false;
let isRendering = false;
let latestAlertSourceId = null;
const alerts = loadAlerts(); // [{ name, url, at }]
const recentAlertKeys = new Map(); // de-dupe local vs SSE alerts

// Personal "space" (a name/initials) so each colleague has their own source
// list. Shared/core sources are visible to everyone regardless.
let nmSpace = (localStorage.getItem("nm_space") || "").trim();

// fetch() wrapper that tags every API call with the current space.
function apiFetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (nmSpace) headers["X-Space"] = nmSpace;
    return fetch(url, { ...opts, headers });
}

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
async function enableNotifications() {
    ensureAudio();
    let perm = "granted";
    if ("Notification" in window) perm = await Notification.requestPermission();
    notificationsEnabled = perm === "granted";
    updateNotifUi();
    // Always play the ping on click: it unlocks audio for this page load AND
    // gives instant feedback that sound works.
    beep();
    if (notificationsEnabled) registerPush();
}
// The button stays visible as a status + test control. It's the reliable place
// to click once per page load to unlock sound (browsers require a gesture).
function updateNotifUi() {
    const btn = $("enableNotifs");
    if (!btn) return;
    btn.hidden = false;
    const status = $("notifStatus");
    if (status) status.classList.remove("warn", "ok", "bad");
    const denied = "Notification" in window && Notification.permission === "denied";
    if (notificationsEnabled && audioReady) {
        btn.innerHTML = '<span class="bell">🔔</span> Notiser på · testa ljud';
        btn.classList.add("on");
        btn.classList.remove("needs-action");
        btn.title = "Notiser och ljud är på. Klicka för att testa pinget.";
        if (status) status.textContent = "";
    } else if (denied) {
        btn.innerHTML = '<span class="bell">🔕</span> Notiser blockerade';
        btn.classList.remove("on", "needs-action");
        btn.title = "Tillåt notiser i webbläsarens inställningar för att få larm.";
        if (status) { status.textContent = "Blockerade i webbläsaren"; status.classList.add("bad"); }
    } else if (notificationsEnabled) {
        // Permission granted, but sound is still locked until a click this load.
        btn.innerHTML = '<span class="bell">🔔</span> Klicka för att tillåta notiser';
        btn.classList.add("needs-action");
        btn.classList.remove("on");
        btn.title = "Notistillstånd finns, men ljudet är låst tills du klickar en gång den här sessionen.";
        if (status) status.textContent = "";
    } else {
        btn.innerHTML = '<span class="bell">🔔</span> Aktivera ljud & notiser';
        btn.classList.add("needs-action");
        btn.classList.remove("on");
        btn.title = "Klicka här för att slå på ljud och banner-notiser – annars får du inga larm.";
        if (status) { status.textContent = "← Klicka för att få larm"; status.classList.add("warn"); }
    }
}
// On load: if the browser already granted permission, turn notifications on
// automatically so the choice persists across reloads.
function initNotifications() {
    if ("Notification" in window && Notification.permission === "granted") {
        notificationsEnabled = true;
        registerPush();
    }
    updateNotifUi();
}
$("enableNotifs").addEventListener("click", enableNotifications);

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
        await apiFetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subscription: sub }),
        });
    } catch (err) {
        console.warn("Push registration failed:", err);
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
    if (!res.ok) throw new Error("Kunde inte ta bort källa");
}
async function fetchHistory(id) {
    const res = await apiFetch(`/api/sources/${id}/history`);
    if (!res.ok) throw new Error("Kunde inte hämta historik");
    return res.json();
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

function renderRow(s) {
    const tr = document.createElement("tr");
    if (s.is_active === 0) tr.classList.add("inactive");
    if (latestAlertSourceId === s.id) tr.classList.add("flash");

    tr.appendChild(statusCell(s));

    const tdSource = document.createElement("td");
    const cell = document.createElement("div");
    cell.className = "source-cell";
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
    cell.appendChild(meta);
    tdSource.appendChild(cell);
    tr.appendChild(tdSource);

    tr.appendChild(timeCell(s.last_notified_at, "Vi larmade"));

    const tdActions = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const label = document.createElement("label");
    label.className = "switch";
    label.title = s.is_active === 1 ? "Pausa bevakning" : "Aktivera bevakning";
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
        delBtn.title = "Ta bort";
        delBtn.addEventListener("click", async () => {
            if (!confirm(`Ta bort "${s.name}"?`)) return;
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

async function render() {
    if (isRendering) return;
    isRendering = true;
    try {
        const sources = await fetchSources();
        const tableEl = $("sourcesTable");
        const emptyEl = $("emptyState");
        const body = $("sourcesBody");
        const clearBtn = $("clearSources");
        if (clearBtn) clearBtn.hidden = sources.length === 0;
        if (!sources.length) {
            tableEl.hidden = true;
            emptyEl.hidden = false;
        } else {
            emptyEl.hidden = true;
            tableEl.hidden = false;
            body.innerHTML = "";
            sources
                .slice()
                .sort((a, b) => (b.last_notified_at || "").localeCompare(a.last_notified_at || ""))
                .forEach((s) => body.appendChild(renderRow(s)));
        }
    } catch (err) {
        console.error("Render error:", err);
    } finally {
        isRendering = false;
    }
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
function addAlert(payload) {
    const at = payload.at || payload.last_notified_at || new Date().toISOString();
    const key = alertKey(payload.id, at);
    if (recentAlertKeys.has(key)) return false;
    recentAlertKeys.set(key, Date.now());
    if (recentAlertKeys.size > 200) recentAlertKeys.clear();

    alerts.unshift({ id: payload.id, name: payload.name, url: payload.url, at, title: payload.latest_item_title || null, articleUrl: payload.latest_item_url || null });
    latestAlertSourceId = payload.id;
    saveAlerts();
    renderAlertLog();
    scheduleSeen();
    return true;
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
    const unread = alerts.reduce((n, a) => n + (isUnread(a.at) ? 1 : 0), 0);
    document.title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

function renderAlertLog() {
    updateTabTitle();
    const log = $("alertLog");
    if (!alerts.length) {
        log.innerHTML = `<li class="alert-empty">Inga larm sedan start. Det dyker upp här direkt.</li>`;
        return;
    }
    log.innerHTML = "";
    alerts.slice(0, 50).forEach((a) => {
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
    if (sound) beep();
    const title = payload.name || "Källa";
    const body = payload.latest_item_title || "Uppdatering upptäckt";
    toast(title, body, "🚨");
    notify(title, body);
    render();
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
    const es = new EventSource(`/api/stream?space=${encodeURIComponent(nmSpace)}`);
    streamConn = es;
    es.addEventListener("hello", () => setLive(true));
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
// Add-source form
// =====================
$("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("formError");
    errEl.hidden = true;
    const name = $("name").value.trim();
    const url = $("url").value.trim();
    try {
        const created = await addSource({ name, url });
        $("name").value = "";
        $("url").value = "";
        await render();
        const how = created.extract_mode === "ticker"
            ? `${name} bevakas som live-ticker`
            : created.feed_url ? `${name} (RSS hittades)` : `${name} bevakas nu`;
        toast("Källa tillagd", how, created.extract_mode === "ticker" ? "⚡" : "📡");
    } catch (err) {
        errEl.textContent = err.message || "Kunde inte lägga till källa";
        errEl.hidden = false;
    }
});
async function clearAllSources() {
    const res = await apiFetch("/api/sources", { method: "DELETE" });
    if (!res.ok) throw new Error("Kunde inte rensa källor");
    return res.json();
}

const clearSourcesBtn = $("clearSources");
if (clearSourcesBtn) {
    clearSourcesBtn.addEventListener("click", async () => {
        if (!confirm("Ta bort ALLA bevakade källor? Detta går inte att ångra.")) return;
        clearSourcesBtn.disabled = true;
        try {
            await clearAllSources();
            await render();
            toast("Källor rensade", "Alla bevakade källor togs bort", "🗑");
        } catch (err) {
            toast("Fel", err.message, "⚠️");
        } finally {
            clearSourcesBtn.disabled = false;
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

// Relative-time refresh (SSE handles real updates)
setInterval(render, 30000);

// =====================
// Start
// =====================
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { ensureAudio(); scheduleSeen(); }
});
window.addEventListener("focus", () => { ensureAudio(); scheduleSeen(); });

// =====================
// Personal space (name gate)
// =====================
function updateSpaceUi() {
    const label = $("spaceName");
    if (label) label.textContent = nmSpace || "—";
}

function showSpaceGate() {
    const gate = $("spaceGate");
    const input = $("spaceInput");
    if (!gate) return;
    gate.hidden = false;
    if (input) {
        input.value = nmSpace;
        setTimeout(() => input.focus(), 50);
    }
}

async function applySpace(name) {
    const clean = String(name || "").trim().slice(0, 60);
    if (!clean) return false;
    const changed = clean.toLowerCase() !== nmSpace.toLowerCase();
    nmSpace = clean;
    try { localStorage.setItem("nm_space", nmSpace); } catch { /* ignore */ }
    updateSpaceUi();
    const gate = $("spaceGate");
    if (gate) gate.hidden = true;
    // (Re)load this space's view and live connection.
    await render();
    connectStream();
    if (changed && notificationsEnabled) registerPush();
    return true;
}

function initSpaceControls() {
    const form = $("spaceForm");
    const input = $("spaceInput");
    const btn = $("spaceBtn");
    if (form) {
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            applySpace(input ? input.value : "");
        });
    }
    if (btn) btn.addEventListener("click", showSpaceGate);
}

(async function start() {
    initNotifications();
    initSpaceControls();
    updateSpaceUi();
    renderAlertLog();
    scheduleSeen();
    if (nmSpace) {
        await render();
        connectStream();
    } else {
        // First visit: ask who they are before loading their space.
        showSpaceGate();
    }
})();
