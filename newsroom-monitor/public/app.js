let notificationsEnabled = false;
let lastSeenChangedAt = null;
let isRendering = false;


// Ljud (kräver user gesture)

let audioCtx = null;

function beep() {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.start();
    setTimeout(() => o.stop(), 150);
}


// Notiser
function notify(title, body) {
    if (!notificationsEnabled) return;
    if (!("Notification" in window)) return;
    new Notification(title, { body });
}

async function enableNotifications() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const perm = await Notification.requestPermission();
    notificationsEnabled = perm === "granted";

    document.getElementById("notifStatus").textContent =
        notificationsEnabled ? "Notiser aktiverade ✅" : "Notiser nekade";
}

document
    .getElementById("enableNotifs")
    .addEventListener("click", enableNotifications);


// Demo bump
const bumpBtn = document.getElementById("bumpDemo");
if (bumpBtn) {
    bumpBtn.addEventListener("click", async () => {
        await fetch("/demo/bump", { method: "POST" });
    });
}


// API-anrop

async function fetchSources() {
    const res = await fetch("/api/sources");
    return res.json();
}

async function toggleSource(id, isActive) {
    await fetch(`/api/sources/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive })
    });
}

async function addSource(name, url) {
    await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url })
    });
}


// Render UI

async function render() {
    if (isRendering) return;
    isRendering = true;

    try {
        const sources = await fetchSources();
        const body = document.getElementById("sourcesBody");
        body.innerHTML = "";

        for (const s of sources) {
            const tr = document.createElement("tr");
            if (s.is_active === 0) tr.classList.add("inactive");

            // Aktiv
            const tdActive = document.createElement("td");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = s.is_active === 1;

            checkbox.addEventListener("change", async () => {
                checkbox.disabled = true;
                await toggleSource(s.id, checkbox.checked);
                await render();
            });

            tdActive.appendChild(checkbox);
            tr.appendChild(tdActive);

            // Namn
            const tdName = document.createElement("td");
            tdName.textContent = s.name || "";
            tr.appendChild(tdName);

            // URL
            const tdUrl = document.createElement("td");
            const a = document.createElement("a");
            a.href = s.url;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = s.url;
            tdUrl.appendChild(a);
            tr.appendChild(tdUrl);

            // Senast kollad
            const tdChecked = document.createElement("td");
            tdChecked.textContent = s.last_checked_at
                ? new Date(s.last_checked_at).toLocaleString()
                : "-";
            tr.appendChild(tdChecked);

            // Senast ändrad
            const tdChanged = document.createElement("td");
            tdChanged.textContent = s.last_changed_at
                ? new Date(s.last_changed_at).toLocaleString()
                : "-";
            tr.appendChild(tdChanged);

            // Senast notifierad (cooldown synlig)
            const tdNotified = document.createElement("td");
            tdNotified.textContent = s.last_notified_at
                ? new Date(s.last_notified_at).toLocaleString()
                : "-";
            tr.appendChild(tdNotified);

            body.appendChild(tr);
        }
    } catch (err) {
        console.error("Render error:", err);
    } finally {
        isRendering = false;
    }
}


// Form: lägg till källa
document.getElementById("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("name").value.trim();
    const url = document.getElementById("url").value.trim();

    await addSource(name, url);

    document.getElementById("name").value = "";
    document.getElementById("url").value = "";

    await render();
});


// Polling för notiser
async function pollForChanges() {
    const sources = await fetchSources();

    let newest = lastSeenChangedAt;
    let newestSource = null;

    for (const s of sources) {
        if (!s.last_notified_at) continue;
        if (!newest || s.last_notified_at > newest) {
            newest = s.last_notified_at;
            newestSource = s;
        }
    }

    if (newest && newest !== lastSeenChangedAt) {
        lastSeenChangedAt = newest;

        const title = "Uppdatering upptäckt";
        const body = `${newestSource?.name || "Källa"} har ändrats`;

        notify(title, body);
        beep();

        render();
    }
}


// Start
render();
setInterval(pollForChanges, 10_000);
setInterval(render, 15_000);
