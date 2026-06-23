const fetch = require("node-fetch");
const config = require("../lib/config");
const logger = require("../lib/logger");
const sse = require("./sse");
const { getPushSubscriptions, removePushSubscription } = require("../db/database");

let webpush = null;
let mailer = null;

function init() {
    // Web Push (VAPID)
    if (config.vapid.publicKey && config.vapid.privateKey) {
        try {
            webpush = require("web-push");
            webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
            logger.info("Web Push enabled");
        } catch (err) {
            logger.warn({ err: err.message }, "Web Push unavailable");
            webpush = null;
        }
    }

    // Email (SMTP)
    if (config.email.smtpUrl && config.email.to) {
        try {
            const nodemailer = require("nodemailer");
            mailer = nodemailer.createTransport(config.email.smtpUrl);
            logger.info("Email notifications enabled");
        } catch (err) {
            logger.warn({ err: err.message }, "Email unavailable");
            mailer = null;
        }
    }
}

async function sendWebhook(payload) {
    if (!config.webhookUrl) return;
    const text = `🚨 ${payload.name} har uppdaterats${payload.latest_item_title ? `: ${payload.latest_item_title}` : ""}`;
    try {
        await fetch(config.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // `text` works for Slack/Discord/Teams; full payload included too.
            body: JSON.stringify({ text, ...payload }),
        });
    } catch (err) {
        logger.warn({ err: err.message }, "Webhook delivery failed");
    }
}

async function sendEmail(payload) {
    if (!mailer) return;
    try {
        await mailer.sendMail({
            from: config.email.from || "newsroom-monitor@localhost",
            to: config.email.to,
            subject: `Uppdatering: ${payload.name}`,
            text: `${payload.name} har uppdaterats.\n${payload.latest_item_title || ""}\n${payload.url}`,
        });
    } catch (err) {
        logger.warn({ err: err.message }, "Email delivery failed");
    }
}

async function sendPush(payload) {
    if (!webpush) return;
    const subs = await getPushSubscriptions();
    const body = JSON.stringify({
        title: payload.name || "Källa",
        body: payload.latest_item_title || "Uppdatering upptäckt",
        url: payload.url,
    });
    await Promise.allSettled(
        subs.map((sub) =>
            webpush.sendNotification(sub, body).catch((err) => {
                if (err.statusCode === 404 || err.statusCode === 410) {
                    return removePushSubscription(sub.endpoint);
                }
                logger.warn({ err: err.message }, "Push delivery failed");
            })
        )
    );
}

// Called by the detector whenever a real, notify-worthy change is detected.
function notifyChange(source, info = {}) {
    const payload = {
        id: source.id,
        name: source.name,
        url: source.url,
        new_items_count: info.new_items_count || 0,
        latest_item_title: info.latest_item_title || null,
        latest_item_url: info.latest_item_url || null,
        last_changed_at: info.last_changed_at || null,
        at: new Date().toISOString(),
    };

    // Instant in-app delivery.
    sse.broadcast("alert", payload);

    // Out-of-band channels (fire and forget).
    sendWebhook(payload);
    sendEmail(payload);
    sendPush(payload);

    return payload;
}

function pushEnabled() {
    return !!webpush;
}

module.exports = { init, notifyChange, pushEnabled };
