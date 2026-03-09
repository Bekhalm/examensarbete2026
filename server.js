console.log("RUNNING SERVER FILE:", __filename);


const path = require("path");
const express = require("express");


const sourcesRouter = require("./routes/sources");
const { startScheduler } = require("./scheduler/scheduler");



const app = express();
const PORT = process.env.PORT || 3000;


app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));


app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Koll
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", sourcesRouter);

// DEMO (för att kunna trigga ändringar vid examination)
let demoVersion = 1;

console.log("Registering demo routes...");


app.get("/demo/source", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="sv">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Demo Source</title>
      </head>
      <body>
        <h1>Demo Source</h1>
        <p><strong>Version:</strong> ${demoVersion}</p>
        <p>Sida för att testa change detection vid examination.</p>
      </body>
    </html>
  `);
});

app.post("/demo/bump", (req, res) => {
  demoVersion += 1;
  res.json({ ok: true, demoVersion });
});

// Starta scheduler
startScheduler(60_000);


app.listen(PORT, () => {
  console.log(`Server is running on port http://localhost:${PORT}`);
});