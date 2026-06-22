self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = {};
    }
    event.waitUntil(
        self.registration.showNotification(data.title || "Uppdatering upptäckt", {
            body: data.body || "",
            icon: "/icon.png",
            data: { url: data.url || "/" },
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || "/";
    event.waitUntil(clients.openWindow(url));
});
