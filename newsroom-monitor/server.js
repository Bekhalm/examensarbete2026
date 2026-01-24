const path = require("path");
const express = require("express");


const sourcesRouter = require("./routes/sources");
const { startScheduler } = require("./scheduler/scheduler");



const app = express();
const PORT = process.env.PORT || 3000;


app.use(express.json());
// Servera frontend 
app.use(express.static(path.join(__dirname, "public")));

// Root ska visa index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Koll
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.use("/api", sourcesRouter);

// Starta scheduler
startScheduler(30_000);

app.listen(PORT, () => {
    console.log(`Server is running on port http://localhost:${PORT}`);
});