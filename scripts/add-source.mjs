// Adds a news website to config.json.
//
// A learner pastes a web address into the box on their own site. That opens a
// request, and this file is what answers it. It:
//   1. works out the feed address, even if they pasted the ordinary one
//   2. checks the feed really works
//   3. gives it a name taken from the feed itself
//   4. writes it into config.json, so the news bot starts reading it
//
// Run by hand for testing:  node scripts/add-source.mjs "https://www.nasa.gov/"

import { readFile, writeFile } from 'node:fs/promises';

const CONFIG_PATH = process.env.CONFIG_PATH || 'config.json';

// Things that are not a web address at all, or that we should not fetch.
function tidyAddress(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('No web address was given.');
  if (text.length > 500) throw new Error('That address is too long to be real.');
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${raw}" is not a web address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only ordinary web addresses work here.');
  }
  // Keep this off private networks: a learner's site must not be able to make
  // the robot knock on doors inside GitHub.
  const host = url.hostname.toLowerCase();
  const blocked = host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host)
    || host.startsWith('[');
  if (blocked) throw new Error('That address is not a public website.');
  return url.toString();
}

const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

async function get(address) {
  const res = await fetch(address, {
    headers: FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`answered with error ${res.status}`);
  return res.text();
}

function looksLikeAFeed(text) {
  return /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text) || /<channel[\s>]/i.test(text);
}

function countStories(text) {
  const items = text.match(/<item[\s>]/gi) || text.match(/<entry[\s>]/gi) || [];
  return items.length;
}

function fallbackNameFromUrl(originalAddress) {
  try {
    const u = new URL(originalAddress);
    const host = u.hostname.replace(/^www\./, '');
    const base = host.split('.')[0];
    const brand = base.length <= 4 ? base.toUpperCase() : base[0].toUpperCase() + base.slice(1);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg && !/^(news|index|home|rss|feed)$/i.test(seg) && seg.length <= 14) {
      const cleanSeg = seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return `${brand} ${cleanSeg}`.slice(0, 28);
    }
    return brand || host;
  } catch {
    return 'News';
  }
}

// The name on the button. Taken from the feed's own title where there is one,
// falling back to the site domain/section when the feed title is generic.
function nameFromFeed(text, feedAddress, originalAddress = feedAddress) {
  const m = text.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  let name = m ? m[1] : '';
  name = name
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  // Feed titles can be long, and often carry the site name after a dash or a
  // bar. Keep the first part, which is the bit worth putting on a button.
  name = name.split(/\s+(?:[|–—]|-{1,2}|·)\s+/)[0].trim();

  const looksGenericOrJunk = !name
    || /records found|search|google news|^site:|^(rss|feed|home|news|atom|untitled)$/i.test(name);
  if (looksGenericOrJunk) {
    return fallbackNameFromUrl(originalAddress);
  }

  if (name.length > 28) name = name.slice(0, 27).replace(/\s+\S*$/, '') + '.';
  return name || fallbackNameFromUrl(originalAddress);
}

// Known publisher RSS mirrors (helpful for sites whose main HTML blocks cloud IPs with 403)
function knownPublisherFeeds(address) {
  try {
    const u = new URL(address);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const p = u.pathname.toLowerCase();

    if (host === 'ndtv.com' || host.endsWith('.ndtv.com')) {
      const list = [];
      if (p.includes('india')) list.push('https://feeds.feedburner.com/ndtvnews-india-news');
      if (p.includes('world')) list.push('https://feeds.feedburner.com/ndtvnews-world-news');
      if (p.includes('latest')) list.push('https://feeds.feedburner.com/ndtvnews-latest');
      if (p.includes('profit') || p.includes('business')) list.push('https://feeds.feedburner.com/ndtvprofit-latest');
      if (p.includes('sports')) list.push('https://feeds.feedburner.com/ndtvsports-latest');
      if (p.includes('movies') || p.includes('entertainment')) list.push('https://feeds.feedburner.com/ndtvmovies-latest');
      if (p.includes('tech') || host.includes('gadgets360')) list.push('https://feeds.feedburner.com/gadgets360-latest');
      list.push('https://feeds.feedburner.com/ndtvnews-top-stories');
      return list;
    }
    if (host === 'bbc.com' || host === 'bbc.co.uk') {
      const list = [];
      if (p.includes('science')) list.push('https://feeds.bbci.co.uk/news/science_and_environment/rss.xml');
      if (p.includes('tech')) list.push('https://feeds.bbci.co.uk/news/technology/rss.xml');
      if (p.includes('world')) list.push('https://feeds.bbci.co.uk/news/world/rss.xml');
      if (p.includes('india')) list.push('https://feeds.bbci.co.uk/news/world/asia/india/rss.xml');
      list.push('https://feeds.bbci.co.uk/news/rss.xml');
      return list;
    }
  } catch { /* ignore */ }
  return [];
}

// A learner will usually paste the address they see in their browser, which is
// the website and not its feed. Build smart candidates in priority order.
function guesses(address) {
  const url = new URL(address);
  const root = `${url.protocol}//${url.host}`;
  const cleanPath = url.pathname.replace(/\/+$/, '');
  const cleanBase = `${root}${cleanPath}`;
  const candidates = [address];

  if (cleanBase !== address) candidates.push(cleanBase);

  // Known official RSS mirrors first for sites that block direct scraping
  candidates.push(...knownPublisherFeeds(address));

  if (cleanPath && cleanPath !== '/') {
    candidates.push(
      `${cleanBase}/feed`,
      `${cleanBase}/rss`,
      `${cleanBase}/feed.xml`,
      `${cleanBase}/rss.xml`,
      `${cleanBase}.rss`,
      `${cleanBase}.xml`,
      `${root}/rss${cleanPath}`,
      `${root}/feed${cleanPath}`,
      `${root}/feeds${cleanPath}`
    );
  }

  candidates.push(
    `${root}/feed`,
    `${root}/rss`,
    `${root}/feed.xml`,
    `${root}/rss.xml`,
    `${root}/index.xml`,
    `${root}/atom.xml`,
    `${root}/feeds/posts/default`,
    `${root}/?feed=rss2`
  );

  return [...new Set(candidates)];
}

// Some sites say where their feed is, inside <link rel="alternate"> or <a> tags.
function feedLinksInPage(html, address) {
  const found = [];
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom|xml)\+?xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) {
      try { found.push(new URL(href[1].replace(/&amp;/g, '&'), address).toString()); } catch { /* skip */ }
    }
  }

  // Also scan <a> links pointing to obvious RSS/Atom/FeedBurner URLs
  const anchors = html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi) || [];
  for (const a of anchors) {
    const href = a.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (/(feeds\.feedburner\.com|\/rss\b|\/feed\b|\.rss\b|\.xml\b)/i.test(href)) {
      try {
        const resolved = new URL(href.replace(/&amp;/g, '&'), address).toString();
        if (/^https?:\/\//i.test(resolved)) found.push(resolved);
      } catch { /* skip */ }
    }
  }

  return [...new Set(found)].slice(0, 6);
}

// Universal fallback via Google News site search RSS when a site blocks direct scraping or lacks an RSS endpoint
function googleNewsCandidates(address) {
  try {
    const u = new URL(address);
    const host = u.hostname.replace(/^www\./, '');
    const cleanPath = u.pathname.replace(/\/+$/, '');
    const scopes = [];
    if (cleanPath && cleanPath !== '/') {
      scopes.push(`site:${host}${cleanPath}`);
    }
    scopes.push(`site:${host}`);
    return scopes.map(
      (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
    );
  } catch {
    return [];
  }
}

export async function findFeed(rawAddress) {
  const address = tidyAddress(rawAddress);
  const tried = [];
  const checked = new Set();

  const tryFeedUrl = async (candidate, inspectHtml = false) => {
    if (checked.has(candidate)) return null;
    checked.add(candidate);
    try {
      const text = await get(candidate);
      if (looksLikeAFeed(text)) {
        const stories = countStories(text);
        if (stories > 0) {
          return {
            feedUrl: candidate,
            name: nameFromFeed(text, candidate, address),
            stories,
          };
        }
        tried.push(`${candidate} (the feed is empty)`);
        return null;
      }

      if (inspectHtml) {
        const links = feedLinksInPage(text, candidate);
        for (const pointed of links) {
          if (checked.has(pointed)) continue;
          checked.add(pointed);
          try {
            const feedText = await get(pointed);
            if (looksLikeAFeed(feedText)) {
              const stories = countStories(feedText);
              if (stories > 0) {
                return {
                  feedUrl: pointed,
                  name: nameFromFeed(feedText, pointed, address),
                  stories,
                };
              }
            }
          } catch { /* try next link */ }
        }
      }
      tried.push(candidate);
    } catch (err) {
      tried.push(`${candidate} (${err.message})`);
    }
    return null;
  };

  for (const candidate of guesses(address)) {
    const shouldInspectHtml = candidate === address
      || candidate === address.split('?')[0].replace(/\/+$/, '')
      || /\/(rss|feeds?)$/i.test(candidate);
    const found = await tryFeedUrl(candidate, shouldInspectHtml);
    if (found) return found;
  }

  for (const fallback of googleNewsCandidates(address)) {
    const found = await tryFeedUrl(fallback, false);
    if (found) return found;
  }

  throw new Error(
    `No news feed was found at that address.\n\nTried:\n- ${tried.join('\n- ')}\n\n` +
    'Not every website publishes a feed. Try another news site or paste its RSS link directly.'
  );
}

export function addToConfig(config, found) {
  // Older copies kept one feedUrl. Turn that into the list before adding.
  let sources = Array.isArray(config.sources) ? [...config.sources] : [];
  if (!sources.length && config.feedUrl) {
    sources = [{ name: config.topic || 'News', feedUrl: config.feedUrl }];
  }

  const already = sources.find((s) => s.feedUrl === found.feedUrl);
  if (already) throw new Error(`That website is already on the list, as "${already.name}".`);
  if (sources.length >= 8) throw new Error('There are already 8 websites. Remove one before adding another.');

  // Two websites must not share a button name.
  let name = found.name;
  if (sources.some((s) => s.name === name)) {
    let n = 2;
    while (sources.some((s) => s.name === `${name} ${n}`)) n++;
    name = `${name} ${n}`;
  }

  sources.push({ name, feedUrl: found.feedUrl });
  const next = { ...config, sources };
  delete next.feedUrl; // the list replaces it
  return { config: next, name };
}

// Running the file directly, rather than importing it, does the whole job.
// Anything that goes wrong is written as a plain sentence, because a learner
// reads it on their own request rather than in a log.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { appendFile } = await import('node:fs/promises');
  const report = async (key, value) => {
    if (!process.env.GITHUB_OUTPUT) return;
    const token = `EOF_${Math.random().toString(36).slice(2)}`;
    await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${token}\n${value}\n${token}\n`);
  };

  try {
    const found = await findFeed(process.argv[2] || process.env.SOURCE_URL);
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    const { config: next, name } = addToConfig(config, found);
    await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
    const line = `Added "${name}" (${found.feedUrl}), ${found.stories} stories.`;
    console.log(line);
    await report('result', 'added');
    await report('message', `Added **${name}**.\n\nFeed: ${found.feedUrl}\nStories found: ${found.stories}\n\nYour site updates on its next run, or press Run workflow on the Actions tab to see it now.`);
  } catch (err) {
    console.error(err.message);
    await report('result', 'failed');
    await report('message', err.message);
    process.exit(1);
  }
}
