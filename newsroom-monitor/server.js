const db = require("../db/database");
const { getAllSources } = require("../db/database");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

//Koll
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// MVP-endpoint som ska lista källor men tomt rn
app.get("/api/sources", async (req, res) => {
    try {
        const sources = await getAllSources();
        res.json(sources);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});


app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
