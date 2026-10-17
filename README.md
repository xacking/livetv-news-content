# Live TV, News & Radio — content feed

The app's whole "backend": a GitHub Action rebuilds the JSON every hour and publishes it to
GitHub Pages at https://xacking.github.io/livetv-news-content/<country>/<file>.json

- `countries.json` — the 20 markets (keep in sync with the app's `assets/countries.json`)
- `scripts/build.mjs` — fetches headlines (Google News RSS), radio stations (radio-browser.info), builds the daily quiz
- `editorial/` — things you edit by hand: breaking-news banner (`<cc>/alerts.json`), TV channels, hidden stations
- Optional secret `ANTHROPIC_API_KEY` (Settings → Secrets → Actions) for AI-written daily quizzes
