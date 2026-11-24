# AI Architects · Science News Aggregator

A clean, kid-friendly news aggregator with RSS/Atom feed discovery, optional Gemini AI summaries, source filtering, keyword search, and read-aloud support.

## Key Features

- **In-app website manager:** Any visitor can click **+ Add a news website**, paste a website URL or RSS/Atom feed link, and immediately load its latest stories without editing files or leaving the page.
- **Smart feed discovery:** Automatically strips tracking parameters, checks section-aware feed paths (e.g. `/india`), inspects HTML pages for RSS/Atom links, checks official RSS mirrors (such as FeedBurner for sites like NDTV or BBC), and falls back to Google News site-search RSS when a site blocks direct scraping or has no built-in RSS endpoint.
- **Manage & refresh sources:** View active websites (up to 8), remove sources with one click, and click **Refresh stories** to pull fresh articles on demand.
- **Memory & deduplication:** Remembers previously saved stories (`sameStory` / `alreadySaved` in `scripts/update-news.mjs`) so duplicate links with different tracking query parameters are never added twice.
- **Optional AI summaries:** Uses Gemini (`config.json` + `GEMINI_API_KEY`) to summarize new articles in 2 short sentences for young readers, falling back gracefully to feed snippets when no API key is configured.

## How This Repo Works

| File | What it does |
| --- | --- |
| `server.js` | Express server (port `3000`) serving the site and providing `/api/sources` and `/api/refresh` endpoints. |
| `index.html` | The frontend UI: topic filters, search, read-aloud toggle, large-text toggle, and the **+ Add a news website** panel. |
| `config.json` | Settings and active `sources` list (`name` and `feedUrl`), topic title, `maxArticles`, and Gemini summary prompt. |
| `public/news.json` | Stored articles and `updatedAt` timestamp displayed by the website. |
| `scripts/add-source.mjs` | Validates public URLs, discovers RSS/Atom feeds (including section feeds, official mirrors, and fallbacks), and updates `config.json`. |
| `scripts/update-news.mjs` | Fetches configured feeds, deduplicates stories, generates optional Gemini AI summaries, and writes `public/news.json`. |
| `.github/workflows/` | Optional GitHub Actions workflows for scheduled news updates and GitHub Pages publishing. |
| `worker/` | Optional Cloudflare Worker helper for static GitHub Pages deployments. |

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. *(Optional)* Create a `.env` file (see `.env.example`) and set `GEMINI_API_KEY` if you want server-side AI summaries when adding or refreshing feeds:
   ```bash
   GEMINI_API_KEY=your_api_key_here
   ```
3. Start the server on port `3000`:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000` in your browser.

## Adding & Managing News Websites

### From the UI (Recommended)

1. Click **`+ Add a news website`** next to the filter buttons.
2. Paste any website address (for example `https://www.ndtv.com/india`, `https://www.sciencedaily.com`, or a direct RSS/Atom URL) and click **Add it**.
3. The server discovers the feed, updates `config.json`, fetches the latest stories into `public/news.json`, and adds a new filter button right away.
4. Inside the same panel, you can:
   - View **Active websites** (up to 8 sources)
   - Click **`×`** on a website chip to remove it (at least 1 source must remain)
   - Click **`Refresh stories`** to fetch the latest articles across all active websites

> **Note:** On ephemeral container environments, edits to `config.json` and `public/news.json` persist for the running session. When deployed as a static site on GitHub Pages, the button automatically falls back to the two-step GitHub Issue / Cloudflare Worker flow.

### Manually via `config.json`

You can also edit the `sources` array in `config.json` directly:

```json
"sources": [
  { "name": "Science", "feedUrl": "https://www.snexplores.org/feed" },
  { "name": "Space", "feedUrl": "https://www.nasa.gov/news-release/feed/" }
]
```

Then click **Refresh stories** in the UI or run:

```bash
node scripts/update-news.mjs
```

### Example Feed URLs

| Topic | URL / Feed |
| --- | --- |
| Science (written for ages 10–14) | `https://www.snexplores.org/feed` |
| Space (NASA) | `https://www.nasa.gov/news-release/feed/` |
| NDTV India | `https://www.ndtv.com/india` (resolves to `https://feeds.feedburner.com/ndtvnews-india-news`) |
| TechCrunch | `https://techcrunch.com/feed/` |
