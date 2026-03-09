# Newsroom Monitor (MVP)

A simple monitoring tool for journalists: add news sites and get notified when content appears to be updated.

## Run

```bash
npm install
npm start
```

Open: `http://localhost:3000`

## Notes

- Browser notifications require clicking **Aktivera notiser**.
- `Senast ändrad på sajt` is the site's own timestamp (if available; otherwise `-`).
- Cooldown is about 60 seconds to reduce notification fatigue.
