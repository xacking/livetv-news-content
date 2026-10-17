#!/usr/bin/env node
// Builds the static content the Ontivo app reads. No server, no database:
// it writes plain JSON into public/, which GitHub Pages (or any static host) serves.
//
//   node scripts/build.mjs            all countries
//   node scripts/build.mjs us jp      only these
//
// Optional environment variables (set them as GitHub Actions secrets):
//   ANTHROPIC_API_KEY   writes a real "Today's 5" quiz in each country's language
//   QUIZ_MODEL          model for the quiz (default claude-haiku-5-5)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const UA = 'OntivoContentBuilder/1.0 (+https://github.com/xacking/livetv-news-content)';
const RADIO_API = 'https://de1.api.radio-browser.info';

const master = JSON.parse(await fs.readFile(path.join(ROOT, 'countries.json'), 'utf8'));
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const countries = master.countries.filter((c) => !only.length || only.includes(c.code));

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { json = false, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url} → ${e.message}`);
      await sleep(800 * (i + 1));
    }
  }
}
async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 1) + '\n');
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const decode = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').trim();
const strip = (s = '') => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : ''; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}="([^"]+)"`)); return m ? decode(m[1]) : ''; };
const hash = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

// ---------- news ----------
function parseRss(xml, topic) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const source = strip(tag(it, 'source'));
    let title = strip(tag(it, 'title'));
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const image = attr(it, 'media:content', 'url') || attr(it, 'media:thumbnail', 'url') || attr(it, 'enclosure', 'url') || '';
    const desc = strip(tag(it, 'description'));
    const link = decode(tag(it, 'link'));
    const date = new Date(decode(tag(it, 'pubDate')) || Date.now());
    const srcUrl = attr(it, 'source', 'url');
    let domain = '';
    try { domain = srcUrl ? new URL(srcUrl).hostname.replace(/^www\./, '') : ''; } catch { /* ignore */ }
    return {
      id: hash(link || title), topic, title, source, domain,
      summary: desc && !desc.startsWith(title) ? desc.slice(0, 280) : '',
      url: link, image, published: isNaN(date) ? new Date().toISOString() : date.toISOString()
    };
  }).filter((s) => s.title && s.url);
}
function googleNewsUrl(c, topic) {
  const q = `hl=${encodeURIComponent(c.news.hl)}&gl=${c.news.gl}&ceid=${encodeURIComponent(c.news.ceid)}`;
  return topic === 'TOP' ? `https://news.google.com/rss?${q}` : `https://news.google.com/rss/headlines/section/topic/${topic}?${q}`;
}
async function buildStories(c) {
  const byTopic = {};
  await pool(master.topics, 3, async (topic) => {
    try { byTopic[topic] = parseRss(await get(googleNewsUrl(c, topic)), topic).slice(0, 25); }
    catch (e) { console.warn(`  ! ${c.code} ${topic}: ${e.message}`); byTopic[topic] = []; }
  });
  // Licensed publisher feeds (with photos) listed in countries.json → "feeds": [{ "topic": "TOP", "url": "..." }]
  for (const f of c.feeds || []) {
    try {
      const items = parseRss(await get(f.url), f.topic || 'TOP');
      byTopic[f.topic || 'TOP'] = [...items, ...(byTopic[f.topic || 'TOP'] || [])].slice(0, 30);
    } catch (e) { console.warn(`  ! ${c.code} feed ${f.url}: ${e.message}`); }
  }
  return { generatedAt: new Date().toISOString(), topics: byTopic };
}

// ---------- radio ----------
const RADIO_CATS = [['news', /news|nachrichten|nyheter|noticias|berita|ニュース|actualit|info/i], ['sports', /sport/i], ['talk', /talk|podcast|comedy|culture|spoken/i]];
async function buildRadio(c) {
  const url = `${RADIO_API}/json/stations/search?countrycode=${c.radio.countrycode}&order=clickcount&reverse=true&limit=60&hidebroken=true&is_https=true`;
  const list = await get(url, { json: true });
  // editorial/<code>/radio.json → { "exclude": ["station name", ...] } to hide stations you don't want.
  const rules = await readJson(path.join(ROOT, 'editorial', c.code, 'radio.json'), { exclude: [] });
  const excluded = new Set((rules.exclude || []).map((x) => x.toLowerCase()));
  const seen = new Set(excluded);
  const clean = (n) => n.replace(/\s*[|(\[].*$/, '').replace(/\s*-\s*(mp3|aac|hd|hq|\d+\s*k(bps)?)\b.*$/i, '').replace(/^[#\s\-–_.]+/, '').trim();
  const playable = (s) => /^(MP3|AAC|AAC\+)$/i.test(s.codec) || !!s.hls || /\.m3u8/.test(s.url_resolved);
  const stations = list.filter((s) => s.url_resolved?.startsWith('https://') && s.name?.trim() && playable(s)).filter((s) => {
    const name = clean(s.name);
    if (!name || name.length > 40) return false; // skip keyword-stuffed directory names
    const k = name.toLowerCase();
    if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 30).map((s) => {
    const text = `${s.tags} ${s.name}`;
    const cat = (RADIO_CATS.find(([, re]) => re.test(text)) || ['music'])[0];
    return {
      id: s.stationuuid, name: clean(s.name), url: s.url_resolved, hls: !!s.hls || /\.m3u8/.test(s.url_resolved),
      logo: s.favicon?.startsWith('https://') ? s.favicon : '', homepage: s.homepage || '',
      codec: s.codec, bitrate: s.bitrate, category: cat, tags: (s.tags || '').split(',').filter(Boolean).slice(0, 5)
    };
  });
  return { generatedAt: new Date().toISOString(), source: 'radio-browser.info', stations };
}

// ---------- TV channels ----------
// Real channels come from broadcast partners: put them in editorial/<code>/channels.json.
// Until then every country gets clearly-labelled demo test streams so the app works end to end.
async function buildChannels(c) {
  const own = await readJson(path.join(ROOT, 'editorial', c.code, 'channels.json'), null);
  if (own) return { generatedAt: new Date().toISOString(), demo: false, channels: own.channels || own };
  const demo = await readJson(path.join(ROOT, 'editorial', '_demo-channels.json'), { channels: [] });
  return { generatedAt: new Date().toISOString(), demo: true, channels: demo.channels };
}

// ---------- Today's 5 ----------
function fallbackQuiz(c, stories) {
  // Template questions the app localises itself: "Which section is this headline from?" / "Who reported this?"
  const pick = [];
  const topics = master.topics.filter((t) => t !== 'TOP' && stories.topics[t]?.length);
  for (const t of topics) { const s = stories.topics[t][0]; if (s && !pick.find((p) => p.title === s.title)) pick.push(s); if (pick.length >= 3) break; }
  const qs = pick.map((s) => {
    const others = topics.filter((t) => t !== s.topic).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [s.topic, ...others].sort(() => Math.random() - 0.5);
    return { type: 'section', headline: s.title, options, answer: options.indexOf(s.topic), url: s.url };
  });
  const top = (stories.topics.TOP || []).filter((s) => s.source);
  const sources = [...new Set(top.map((s) => s.source))];
  for (const s of top.slice(0, 6)) {
    if (qs.length >= 5 || sources.length < 4) break;
    const options = [s.source, ...sources.filter((x) => x !== s.source).sort(() => Math.random() - 0.5).slice(0, 3)].sort(() => Math.random() - 0.5);
    if (!qs.find((q) => q.headline === s.title)) qs.push({ type: 'source', headline: s.title, options, answer: options.indexOf(s.source), url: s.url });
  }
  return qs.slice(0, 5);
}
async function aiQuiz(c, stories) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const heads = master.topics.flatMap((t) => (stories.topics[t] || []).slice(0, 3).map((s) => `- [${t}] ${s.title} (${s.source})`)).slice(0, 24).join('\n');
  const body = {
    model: process.env.QUIZ_MODEL || 'claude-haiku-5-5', max_tokens: 1800,
    messages: [{ role: 'user', content:
      `You write a friendly 5-question daily news quiz for readers in ${c.country}. Write everything in the language with code "${c.lang}".\n` +
      `Use ONLY facts stated in these headlines; never invent details. Each question has 4 short options and exactly one correct answer.\n` +
      `Headlines:\n${heads}\n\nReply with JSON only: {"questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"one short sentence","headline":"the headline it came from"}]}` }]
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const text = (await res.json()).content.map((b) => b.text || '').join('');
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const qs = (parsed.questions || []).filter((q) => q.question && q.options?.length === 4 && q.answer >= 0 && q.answer < 4).slice(0, 5);
    return qs.length >= 3 ? qs.map((q) => ({ type: 'mcq', ...q })) : null;
  } catch (e) { console.warn(`  ! ${c.code} AI quiz: ${e.message}`); return null; }
}
async function buildQuiz(c, stories) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format(new Date());
  const prev = await readJson(path.join(OUT, c.code, 'quiz.json'), null);
  if (prev?.date === date && prev.questions?.length) return prev; // one quiz per local day
  const questions = (await aiQuiz(c, stories)) || fallbackQuiz(c, stories);
  return { date, generatedAt: new Date().toISOString(), questions };
}

// ---------- per-country config & alerts (edited by hand, served as-is) ----------
async function buildConfig(c) {
  const defaults = {
    minAppVersion: '1.0.0',
    ads: { enabled: true, nativeEvery: 6, interstitialAfterQuizzes: 2 },
    features: { liveTv: true, radio: true, quiz: true, shorts: false, leagues: true },
    refreshMinutes: 15
  };
  const own = await readJson(path.join(ROOT, 'editorial', c.code, 'config.json'), {});
  return { ...defaults, ...own, ads: { ...defaults.ads, ...(own.ads || {}) }, features: { ...defaults.features, ...(own.features || {}) } };
}
async function buildAlerts(c) {
  // { "breaking": { "id": "storm-1", "headline": "...", "url": "...", "action": "live:5", "expires": "2026-10-16T23:00:00Z" } }
  const a = await readJson(path.join(ROOT, 'editorial', c.code, 'alerts.json'), { breaking: null });
  if (a.breaking?.expires && new Date(a.breaking.expires) < new Date()) a.breaking = null;
  return a;
}

// ---------- run ----------
const manifest = await readJson(path.join(OUT, 'manifest.json'), { countries: {} });
console.log(`Building ${countries.length} countries → public/`);
for (const c of countries) {
  const t0 = Date.now();
  const dir = path.join(OUT, c.code);
  const stories = await buildStories(c);
  const radio = await buildRadio(c).catch((e) => { console.warn(`  ! ${c.code} radio: ${e.message}`); return null; });
  const [channels, quiz, config, alerts] = await Promise.all([buildChannels(c), buildQuiz(c, stories), buildConfig(c), buildAlerts(c)]);
  await writeJson(path.join(dir, 'stories.json'), stories);
  if (radio) await writeJson(path.join(dir, 'radio.json'), radio);
  await writeJson(path.join(dir, 'channels.json'), channels);
  await writeJson(path.join(dir, 'quiz.json'), quiz);
  await writeJson(path.join(dir, 'config.json'), config);
  await writeJson(path.join(dir, 'alerts.json'), alerts);
  const n = Object.values(stories.topics).reduce((a, b) => a + b.length, 0);
  manifest.countries[c.code] = { updatedAt: new Date().toISOString(), stories: n, stations: radio?.stations.length ?? manifest.countries[c.code]?.stations ?? 0, quiz: quiz.questions.length, quizType: quiz.questions[0]?.type || 'none' };
  console.log(`  ✓ ${c.code}  ${n} stories · ${radio?.stations.length ?? '–'} stations · ${quiz.questions.length} quiz (${quiz.questions[0]?.type}) · ${Date.now() - t0} ms`);
}
manifest.generatedAt = new Date().toISOString();
await writeJson(path.join(OUT, 'manifest.json'), manifest);
await writeJson(path.join(OUT, 'countries.json'), master);
await fs.writeFile(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Ontivo content</title><body style="font:15px system-ui;padding:24px"><h1>Ontivo content feed</h1><p>Static JSON for the Ontivo app. Updated ${manifest.generatedAt}.</p><ul>${Object.entries(manifest.countries).map(([k, v]) => `<li><b>${k}</b> · ${v.stories} stories · ${v.stations} stations · quiz: ${v.quiz} · <a href="${k}/stories.json">stories</a> · <a href="${k}/radio.json">radio</a> · <a href="${k}/channels.json">tv</a> · <a href="${k}/quiz.json">quiz</a></li>`).join('')}</ul>\n`);
console.log('Done.');

// node scripts/build.mjs --seed-app  → also refresh the snapshot bundled inside the app (app/assets/seed)
if (process.argv.includes('--seed-app')) {
  const seedDir = path.resolve(ROOT, '..', 'app', 'assets', 'seed');
  for (const c of countries) {
    for (const f of ['stories', 'radio', 'channels', 'quiz', 'config', 'alerts']) {
      const src = path.join(OUT, c.code, `${f}.json`);
      const data = await readJson(src, null);
      if (data) { await fs.mkdir(path.join(seedDir, c.code), { recursive: true }); await fs.writeFile(path.join(seedDir, c.code, `${f}.json`), JSON.stringify(data)); }
    }
  }
  console.log('App snapshot refreshed → app/assets/seed');
}
