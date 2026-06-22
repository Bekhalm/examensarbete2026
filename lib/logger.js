const pino = require("pino");
const config = require("./config");

const logger = pino({
    level: process.env.LOG_LEVEL || (config.env === "production" ? "info" : "debug"),
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
