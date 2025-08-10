// scripts/rss-to-telegram.mjs

import fs from "node:fs/promises";
import crypto from "node:crypto";
import Parser from "rss-parser";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

// === Alap env-k ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
let   GIST_ID = (process.env.GIST_ID || "").trim();

const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || "10", 10);
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "500", 10);
const DEBUG = (process.env.DEBUG || "0") === "1";
const SHOW_MATCHED = (process.env.SHOW_MATCHED || "1") === "1"; // 1 = "Találat:" sor

// === Google News integráció ===
const GNEWS_FROM_KEYWORDS = (process.env.GNEWS_FROM_KEYWORDS || "1") === "1";
const GNEWS_HL   = process.env.GNEWS_HL   || "hu";
const GNEWS_GL   = process.env.GNEWS_GL   || "HU";
const GNEWS_CEID = process.env.GNEWS_CEID || "HU:hu";
const GNEWS_WHEN = process.env.GNEWS_WHEN || "";   // pl. "1h", "3d"
const GNEWS_EXTRA = process.env.GNEWS_EXTRA || ""; // pl. "-recipe -sport"

// === AI összefoglaló ===
const SUMMARY_ENABLED = (process.env.SUMMARY_ENABLED || "1") === "1";
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-4o-mini";
const SUMMARY_LANG = (process.env.SUMMARY_LANG || "hu").toLowerCase(); // "hu" | "en" | "auto"
const SUMMARY_MAX_PER_RUN = parseInt(process.env.SUMMARY_MAX_PER_RUN || "30", 10);

const openai = SUMMARY_ENABLED && process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// === Állapot (Gist) ===
const STATE_FILENAME = "state.json";
const GITHUB_API = "https://api.github.com";
const FETCH_OPTS = {
  headers: {
    "Authorization": `token ${GIST_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }
};

// ---------- Közös segédek ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const canonicalId = (e) =>
  sha256(e.id || e.guid || `${e.link||""}|${e.title||""}|${e.isoDate||e.pubDate||""}`);

const escapeHtml = (t="") =>
  t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

const toHUDateTime = (d) => {
  try {
    const dt = new Date(d);
    return dt.toLocaleString("hu-HU", {
      timeZone: "Europe/Budapest",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).replace(/\./g,'.').replace(',','').trim();
  } catch { return ""; }
};

const normalizeForMatch = (s="") =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu,"");

const hostFromUrl = (u="") => {
  try { return new URL(u).hostname.replace(/^www\./,""); }
  catch { return ""; }
};

const firstImageFromEntry = (e) => {
  if (e.enclosure?.url && (e.enclosure.type || "").startsWith("image")) return e.enclosure.url;
  if (Array.isArray(e.media?.content)) {
    const m = e.media.content.find(m => (m.medium==="image") || (m.type||"").startsWith("image"));
    if (m?.url) return m.url;
  } else if (e.media?.content?.url && ((e.media.content.type||"").startsWith("image") || e.media.content.medium==="image")) {
    return e.media.content.url;
  }
  const html = e["content:encoded"] || e.content || "";
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
};

const trimTo = (s, max) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

const makeHashtag = (s) => {
  const base = normalizeForMatch(s).replace(/[^a-z0-9_]+/g,"");
  if (!base) return null;
  return "#"+trimTo(base, 30);
};

const extractTags = (entry, feedTitle) => {
  const tags = new Set();
  const host = hostFromUrl(entry.link || "");
  if (host) tags.add(makeHashtag(host) || "");
  if (Array.isArray(entry.categories)) {
    entry.categories.slice(0,4).forEach(c => { const t=makeHashtag(c); if(t) tags.add(t); });
  }
  const hay = normalizeForMatch(
    [entry.title||"", entry.contentSnippet||entry.summary||"", entry.link||""].join(" ")
  );
  KEYWORDS.forEach(k => { if (k && hay.includes(k)) { const t=makeHashtag(KW_MAP.get(k) || k); if(t) tags.add(t); }});
  if (feedTitle) { const t=makeHashtag(feedTitle); if (t) tags.add(t); }
  const out = [...tags].filter(Boolean).slice(0,5);
  return out.length ? " " + out.join(" ") : "";
};

// HTML üzenet (opcionális AI-summarival)
const buildHTMLMessage = (feedTitle, e, matchedOriginals = [], summaryText = "") => {
  const title = e.title || "Új bejegyzés";
  const link = e.link || "";
  const source = hostFromUrl(link) || feedTitle;
  const when = toHUDateTime(e.isoDate || e.pubDate || Date.now());

  let sum = (e.contentSnippet || e.summary || "").replace(/\s+/g," ").trim();
  sum = trimTo(sum, 320);

  const tags = extractTags(e, feedTitle);
  const head = `📰 <b>${escapeHtml(title)}</b>\n<i>${escapeHtml(source)}</i> • ${escapeHtml(when)}`;
  const ai   = summaryText ? `\n\n<b>Összefoglaló</b>: ${escapeHtml(summaryText)}` : "";
  const body = sum ? `\n\n${escapeHtml(sum)}` : "";
  const matchLine = (SHOW_MATCHED && matchedOriginals.length)
    ? `\n\n🎯 <i>Találat:</i> ${escapeHtml(matchedOriginals.join(", "))}`
    : "";
  const cta  = link ? `\n\n👉 <a href="${escapeHtml(link)}">Olvass tovább</a>` : "";
  return head + ai + body + matchLine + cta + tags;
};

// kulcsszavak/tiltások fájlokból + env fallback
async function readListFile(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  } catch { return []; }
}

let RAW_KEYWORDS = [];   // eredeti forma (idézőjelek maradnak)
let KEYWORDS = [];       // normalizált (ékezet nélkül, lower)
let EXCLUDE  = [];
let KW_MAP   = new Map(); // normalizált -> eredeti

function getMatchInfo(entry) {
  const textRaw = [
    entry.title || "",
    entry.contentSnippet || entry.summary || "",
    Array.isArray(entry.categories) ? entry.categories.join(" ") : "",
    entry.link || ""
  ].join(" ");
  const hay = normalizeForMatch(textRaw);

  let excludeHit = null;
  for (const k of EXCLUDE) {
    if (k && hay.includes(k)) { excludeHit = k; break; }
  }

  const matched = new Set();
  for (const k of KEYWORDS) {
    if (k && hay.includes(k)) matched.add(k);
  }
  return { excludeHit, matched };
}

// Link + cím deduplikáció
function normalizeUrl(u = "") {
  try {
    const url = new URL(u);
    url.hash = "";
    const drop = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid","mc_cid","mc_eid","ref"]);
    [...url.searchParams.keys()].forEach(k => { if (drop.has(k.toLowerCase())) url.searchParams.delete(k); });
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/,"")}${url.search ? `?${url.searchParams.toString()}` : ""}`;
  } catch { return ""; }
}

const STOP = new Set([
  "a","az","és","vagy","hogy","egy","mint","mert","szerint",
  "the","and","or","in","on","at","of","to","for","as","is","are","was","were",
  "after","before","with","by","from","this","that","say","says"
]);

function titleSignature(title = "") {
  const norm = normalizeForMatch(title)
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = norm.split(" ")
    .filter(t => t && t.length > 2 && !STOP.has(t))
    .slice(0, 12)
    .sort();
  return sha256(tokens.join(" "));
}

// === Gist state ===
async function loadState() {
  if (!GIST_ID) return { seen:new Set(), seenLinks:new Set(), seenTitles:new Set() };
  const r = await fetch(`${GITHUB_API}/gists/${GIST_ID}`, FETCH_OPTS);
  if (!r.ok) throw new Error(`Gist GET failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const file = data.files?.[STATE_FILENAME]?.content;
  if (!file) return { seen:new Set(), seenLinks:new Set(), seenTitles:new Set() };
  const parsed = JSON.parse(file);
  return {
    seen:       new Set(parsed.seen || []),
    seenLinks:  new Set(parsed.seen_links || []),
    seenTitles: new Set(parsed.seen_titles || [])
  };
}
async function saveState(state) {
  const files = { [STATE_FILENAME]: { content: JSON.stringify({
    seen:        [...state.seen].sort(),
    seen_links:  [...state.seenLinks].sort(),
    seen_titles: [...state.seenTitles].sort()
  }, null, 2) } };
  if (GIST_ID) {
    const r = await fetch(`${GITHUB_API}/gists/${GIST_ID}`, { method:"PATCH", ...FETCH_OPTS, body: JSON.stringify({ files }) });
    if (!r.ok) throw new Error(`Gist PATCH failed: ${r.status} ${r.statusText}`);
  } else {
    const r = await fetch(`${GITHUB_API}/gists`, { method:"POST", ...FETCH_OPTS, body: JSON.stringify({ files, description:"Telegram RSS bot state", public:false }) });
    if (!r.ok) throw new Error(`Gist POST failed: ${r.status} ${r.statusText}`);
    const created = await r.json();
    GIST_ID = created.id;
    console.log(`Created Gist with id: ${GIST_ID}`);
  }
}

// === Feeds ===
async function readFeedsList(path="feeds.txt") {
  const raw = await fs.readFile(path, "utf8");
  return raw
    .split("\n")
    .map(s => s.split("#")[0].trim()) // inline komment
    .filter(s => s);
}

// Google News helpers
function isGnewsUrl(u="") {
  return /^https?:\/\/news\.google\.com\/rss\/search/i.test(u);
}
function gnewsUrl(q, {hl=GNEWS_HL, gl=GNEWS_GL, ceid=GNEWS_CEID} = {}) {
  const params = new URLSearchParams({ q, hl, gl, ceid });
  return `https://news.google.com/rss/search?${params.toString()}`;
}
function buildGnewsFeedsForKeywords(rawKeywords) {
  return rawKeywords.map(k => {
    const parts = [k.trim()];
    if (GNEWS_EXTRA.trim()) parts.push(GNEWS_EXTRA.trim());
    if (GNEWS_WHEN.trim())  parts.push(`when:${GNEWS_WHEN.trim()}`);
    const q = parts.filter(Boolean).join(" ");
    return gnewsUrl(q);
  });
}

// === AI összefoglaló készítése ===
async function generateSummary(entry, feedTitle) {
  if (!openai) return "";

  const title = (entry.title || "").trim();
  const host  = hostFromUrl(entry.link || "") || (feedTitle || "").trim();
  const snippet = (entry.contentSnippet || entry.summary || "")
    .replace(/\s+/g," ")
    .trim()
    .slice(0, 1000);

  const lang = ["hu","en","auto"].includes(SUMMARY_LANG) ? SUMMARY_LANG : "hu";
  const instruction =
    lang === "auto"
      ? "Write a neutral, 2–4 sentence news brief in the article's language. No clickbait, no emojis."
      : `Írj ${lang === "hu" ? "magyar" : "angol"} nyelven 2–4 mondatos, tényszerű hírösszefoglalót. Ne használj clickbaitet vagy emojikat.`;

  const input = [
    instruction,
    `Cím/Title: ${title}`,
    `Forrás/Source: ${host}`,
    `Kivonat/Excerpt: ${snippet || "(csak cím áll rendelkezésre)"}`,
  ].join("\n");

  try {
    const resp = await openai.responses.create({
      model: SUMMARY_MODEL,
      input
    });
    // kompatibilis kinyerés
    const txt = (resp.output_text ||
      resp?.content?.[0]?.text ||
      resp?.choices?.[0]?.message?.content ||
      "").toString().trim();
    return txt;
  } catch (err) {
    console.warn("[WARN] AI összefoglaló hiba:", err?.message || err);
    return "";
  }
}

// ---------- Main ----------
async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !GIST_TOKEN) {
    throw new Error("Hiányzó env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, GIST_TOKEN kötelező.");
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling:false });
  const parser = new Parser({ timeout: 20000 });

  // kulcsszavak / exclude
  const kwFromFile = await readListFile("keywords.txt");
  const exFromFile = await readListFile("exclude.txt");

  RAW_KEYWORDS = (kwFromFile.length ? kwFromFile : (process.env.KEYWORDS || "").split(/[,\n]/))
    .map(s => s.trim()).filter(Boolean);

  KEYWORDS = RAW_KEYWORDS.map(normalizeForMatch);
  KW_MAP = new Map();
  RAW_KEYWORDS.forEach(k => {
    const n = normalizeForMatch(k);
    if (n && !KW_MAP.has(n)) KW_MAP.set(n, k);
  });

  EXCLUDE  = (exFromFile.length ? exFromFile : (process.env.EXCLUDE_KEYWORDS || "").split(/[,\n]/))
    .map(s => s.trim()).filter(Boolean).map(normalizeForMatch);

  // feedlista: előbb GNews, aztán base feedek
  let baseFeeds = await readFeedsList();
  baseFeeds = baseFeeds.filter(u => !isGnewsUrl(u));

  let gnewsFeeds = [];
  if (GNEWS_FROM_KEYWORDS && RAW_KEYWORDS.length) {
    gnewsFeeds = buildGnewsFeedsForKeywords(RAW_KEYWORDS);
  }

  const feeds = [...gnewsFeeds, ...baseFeeds];

  if (DEBUG) {
    console.log(`DEBUG: GNews feeds: ${gnewsFeeds.length}, base feeds: ${baseFeeds.length}, total: ${feeds.length}`);
    // console.log(feeds);
  }

  const state = await loadState();
  let sent = 0, skippedByExclude = 0, skippedByKeywords = 0;

  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const feedTitle = feed.title || url;
      const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);

      for (const e of [...items].reverse()) {
        const id   = canonicalId(e);
        const nurl = normalizeUrl(e.link || "");
        const tsig = titleSignature(e.title || "");

        // duplikációk
        if (state.seen.has(id) ||
            (nurl && state.seenLinks.has(nurl)) ||
            (tsig && state.seenTitles.has(tsig))) {
          continue;
        }

        // kulcsszűrés
        const { excludeHit, matched } = getMatchInfo(e);
        if (excludeHit) { skippedByExclude++; continue; }
        if (KEYWORDS.length && matched.size === 0) { skippedByKeywords++; continue; }

        const matchedOriginals = [...matched].map(n => KW_MAP.get(n) || n);

        // AI összefoglaló (futásonkénti limit)
        let summaryText = "";
        if (SUMMARY_ENABLED && SUMMARY_MAX_PER_RUN > 0) {
          globalThis.__summaryCount = (globalThis.__summaryCount || 0);
          if (globalThis.__summaryCount < SUMMARY_MAX_PER_RUN) {
            summaryText = await generateSummary(e, feedTitle);
            globalThis.__summaryCount++;
          }
        }

        const html = buildHTMLMessage(feedTitle, e, matchedOriginals, summaryText);
        const image = firstImageFromEntry(e);

        try {
          if (image) {
            const caption = trimTo(html, 1024); // Telegram caption limit
            await bot.sendPhoto(TELEGRAM_CHANNEL_ID, image, { caption, parse_mode: "HTML" });
          } else {
            await bot.sendMessage(TELEGRAM_CHANNEL_ID, html, { parse_mode: "HTML", disable_web_page_preview: false });
          }
          state.seen.add(id);
          if (nurl) state.seenLinks.add(nurl);
          if (tsig) state.seenTitles.add(tsig);
          sent++;
          await sleep(SEND_DELAY_MS);
        } catch (err) {
          console.error("[ERROR] Küldési hiba:", err?.message || err);
        }
      }
    } catch (err) {
      console.warn("[WARN] Feed hiba:", url, err?.message || err);
    }
  }

  await saveState(state);
  console.log(`Kész. Elküldött üzenetek: ${sent} | Kizárt (exclude): ${skippedByExclude} | Nem egyezett (keywords): ${skippedByKeywords}`);
  if (!process.env.GIST_ID && GIST_ID) console.log(`GIST_ID=${GIST_ID}`);
}

main().catch(e => { console.error(e); process.exit(1); });
