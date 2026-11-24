import express from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFeed, addToConfig } from './scripts/add-source.mjs';
import {
  sameStory,
  sourcesFromConfig,
  getFeedText,
  parseFeed,
} from './scripts/update-news.mjs';
import { adaptArticlesForYoungReaders } from './scripts/reading-level.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const NEWS_PATH = path.join(__dirname, 'public', 'news.json');
const PORT = Number(process.env.PORT) || 3000;
const MAX_SOURCES = 8;

const app = express();
app.use(express.json({ limit: '16kb' }));

// Serialize config/news writes so concurrent requests never clobber JSON files.
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {});
  return next;
}

async function readConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

async function writeConfig(cfg) {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

async function readNews(topic = 'Science News') {
  try {
    return JSON.parse(await readFile(NEWS_PATH, 'utf8'));
  } catch {
    return { topic, updatedAt: null, articles: [] };
  }
}

async function writeNews(data) {
  await mkdir(path.dirname(NEWS_PATH), { recursive: true });
  await writeFile(NEWS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function mergeArticles(candidates, existingArticles, sources, maxTotal = 12) {
  const activeNames = new Set(sources.map((s) => s.name));
  const byKey = new Map();

  // Keep existing saved articles first (preserving AI summaries) if their source is still active
  for (const a of existingArticles) {
    if (!a || !a.link || a.sample) continue;
    if (a.source && activeNames.size > 0 && !activeNames.has(a.source)) continue;
    const key = sameStory(a.link);
    if (!byKey.has(key)) byKey.set(key, a);
  }

  for (const a of candidates) {
    if (!a || !a.link) continue;
    const key = sameStory(a.link);
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        ...a,
        title: a.summary ? a.title : prev.title,
        summary: a.summary || prev.summary || null,
      });
    } else {
      byKey.set(key, a);
    }
  }

  const all = Array.from(byKey.values()).sort((a, b) =>
    (b.published || '').localeCompare(a.published || '')
  );

  const targetTotal = Math.max(maxTotal, sources.length * 4);
  if (sources.length <= 1) {
    return all.slice(0, targetTotal);
  }

  // Guarantee every configured website keeps at least a few newest articles
  const perSourceMin = Math.max(3, Math.floor(targetTotal / sources.length));
  const chosen = [];
  const chosenKeys = new Set();

  for (const src of sources) {
    const srcItems = all.filter((a) => a.source === src.name).slice(0, perSourceMin);
    for (const item of srcItems) {
      const k = sameStory(item.link);
      if (!chosenKeys.has(k)) {
        chosenKeys.add(k);
        chosen.push(item);
      }
    }
  }

  for (const item of all) {
    if (chosen.length >= targetTotal) break;
    const k = sameStory(item.link);
    if (!chosenKeys.has(k)) {
      chosenKeys.add(k);
      chosen.push(item);
    }
  }

  return chosen.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
}

// List configured news websites
app.get('/api/sources', async (_req, res) => {
  try {
    const cfg = await readConfig();
    res.json({
      sources: sourcesFromConfig(cfg),
      maxSources: MAX_SOURCES,
    });
  } catch {
    res.status(500).json({ error: 'Could not read configured websites.' });
  }
});

// Add a new website by URL or RSS/Atom feed URL
app.post('/api/sources', async (req, res) => {
  const rawAddress = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  if (!rawAddress) {
    return res.status(400).json({ error: 'Type a web address first.' });
  }

  try {
    const found = await findFeed(rawAddress);

    const result = await withWriteLock(async () => {
      const cfg = await readConfig();
      const { config: nextCfg, name } = addToConfig(cfg, found);

      // Fetch stories from the newly added feed and adapt for ages 10-14
      let rawArticles = [];
      try {
        const xml = await getFeedText(found.feedUrl);
        rawArticles = parseFeed(xml).map((item) => ({ ...item, source: name }));
      } catch {
        // Feed was already verified by findFeed; continue even if second fetch glitches
      }

      const adaptation = await adaptArticlesForYoungReaders(rawArticles, nextCfg, 10);

      if (rawArticles.length > 0 && adaptation.articles.length === 0) {
        throw new Error('No age-appropriate (ages 10–14) stories were found on that website.');
      }

      await writeConfig(nextCfg);

      const saved = await readNews(nextCfg.topic || 'Science News');
      const sources = sourcesFromConfig(nextCfg);
      const articles = mergeArticles(
        adaptation.articles,
        saved.articles || [],
        sources,
        nextCfg.maxArticles || 12
      );

      await writeNews({
        topic: nextCfg.topic || 'Science News',
        updatedAt: new Date().toISOString(),
        articles,
      });

      return {
        ok: true,
        name,
        feedUrl: found.feedUrl,
        stories: adaptation.articles.length || found.stories,
        filteredCount: adaptation.filteredCount,
        aiApplied: adaptation.aiApplied,
        aiNotice: adaptation.aiNotice,
        aiError: adaptation.aiError,
        sources,
      };
    });

    res.json(result);
  } catch (err) {
    const message = String(err?.message || 'Could not add that website.')
      .split('\n\nTried:')[0]
      .trim();
    res.status(400).json({ error: message });
  }
});

// Remove a configured website
app.delete('/api/sources', async (req, res) => {
  const feedUrl = typeof req.body?.feedUrl === 'string' ? req.body.feedUrl.trim() : '';
  if (!feedUrl) {
    return res.status(400).json({ error: 'Missing website feedUrl.' });
  }

  try {
    const result = await withWriteLock(async () => {
      const cfg = await readConfig();
      const current = sourcesFromConfig(cfg);
      const remaining = current.filter((s) => s.feedUrl !== feedUrl);

      if (remaining.length === current.length) {
        throw new Error('That website is not on your list.');
      }
      if (remaining.length === 0) {
        throw new Error('Keep at least one news website in your list.');
      }

      const nextCfg = { ...cfg, sources: remaining };
      delete nextCfg.feedUrl;
      await writeConfig(nextCfg);

      const saved = await readNews(nextCfg.topic || 'Science News');
      const activeNames = new Set(remaining.map((s) => s.name));
      let articles = (saved.articles || []).filter((a) => !a.source || activeNames.has(a.source));

      // If removing a source left too few stories, pull fresh ones from remaining sources
      if (articles.length < 4) {
        const fetched = [];
        for (const src of remaining) {
          try {
            const xml = await getFeedText(src.feedUrl);
            fetched.push(...parseFeed(xml).map((item) => ({ ...item, source: src.name })));
          } catch { /* skip broken feed */ }
        }
        const adaptation = await adaptArticlesForYoungReaders(fetched, nextCfg, 10);
        articles = mergeArticles(adaptation.articles, articles, remaining, nextCfg.maxArticles || 12);
      }

      await writeNews({
        topic: nextCfg.topic || 'Science News',
        updatedAt: new Date().toISOString(),
        articles,
      });

      return { ok: true, sources: remaining };
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Could not remove that website.' });
  }
});

// Refresh stories from all configured websites and maintain ages 10-14 reading level
app.post('/api/refresh', async (_req, res) => {
  try {
    const result = await withWriteLock(async () => {
      const cfg = await readConfig();
      const sources = sourcesFromConfig(cfg);
      if (sources.length === 0) {
        throw new Error('No websites are configured.');
      }

      const settled = await Promise.allSettled(
        sources.map(async (src) => {
          const xml = await getFeedText(src.feedUrl);
          return parseFeed(xml).map((item) => ({ ...item, source: src.name }));
        })
      );

      const fresh = [];
      const broken = [];
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          fresh.push(...outcome.value);
        } else {
          broken.push(sources[i].name);
        }
      });

      if (fresh.length === 0) {
        throw new Error('Could not reach any of the configured news feeds right now.');
      }

      const saved = await readNews(cfg.topic || 'Science News');
      const merged = mergeArticles(fresh, saved.articles || [], sources, cfg.maxArticles || 12);

      // Adapt any stories that don't yet have an age 10-14 AI summary
      const needAdaptation = merged.filter((a) => !a.summary);
      const alreadyAdapted = merged.filter((a) => Boolean(a.summary));
      const adaptation = await adaptArticlesForYoungReaders(needAdaptation, cfg, 12);

      const articles = [...alreadyAdapted, ...adaptation.articles].sort((a, b) =>
        (b.published || '').localeCompare(a.published || '')
      );

      await writeNews({
        topic: cfg.topic || 'Science News',
        updatedAt: new Date().toISOString(),
        articles,
      });

      return {
        ok: true,
        count: articles.length,
        filteredCount: adaptation.filteredCount,
        aiApplied: adaptation.aiApplied,
        aiNotice: adaptation.aiNotice,
        aiError: adaptation.aiError,
        broken,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Could not refresh stories.' });
  }
});

// Serve public/ first so ./news.json resolves to public/news.json
app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.json', (_req, res) => {
  res.sendFile(CONFIG_PATH);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Science News server listening on http://0.0.0.0:${PORT}`);
});
