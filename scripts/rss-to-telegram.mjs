import fs from "node:fs/promises";
import crypto from "node:crypto";
import Parser from "rss-parser";
import TelegramBot from "node-telegram-bot-api";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
let   GIST_ID = (process.env.GIST_ID || "").trim();

const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || "10", 10);
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "500", 10);
const DEBUG = (process.env.DEBUG || "0") === "1";

const STATE_FILENAME = "state.json";
const GITHUB_API = "https://api.github.com";
const FETCH_OPTS = {
  headers: {
    "Authorization": `token ${GIST_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }
};

// ---------- Helpers ----------
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
  KEYWORDS.forEach(k => { if (k && hay.includes(k)) { const t=makeHashtag(k); if(t) tags.add(t); }});
  if (feedTitle) { const t=makeHashtag(feedTitle); if (t) tags.add(t); }
  const out = [...tags].filter(Boolean).slice(0,5);
  return out.length ? " " + out.join(" ") : "";
};

const buildHTMLMessage = (feedTitle, e) => {
  const title = e.title || "Új bejegyzés";
  const link = e.link || "";
  const source = hostFromUrl(link) || feedTitle;
  const when = toHUDateTime(e.isoDate || e.pubDate || Date.now());

  let sum = (e.contentSnippet || e.summary || "").replace(/\s+/g," ").trim();
  sum = trimTo(sum, 320);

  const tags = extractTags(e, feedTitle);
  const head = `📰 <b>${escapeHtml(title)}</b>\n<i>${escapeHtml(source)}</i> • ${escapeHtml(when)}`;
  const body = sum ? `\n\n${escapeHtml(sum)}` : "";
  const cta  = link ? `\n\n👉 <a href="${escapeHtml(link)}">Olvass tovább</a>` : "";
  return head + body + cta + tags;
};

async function readListFile(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  } catch { return []; }
}

let KEYWORDS = [];
let EXCLUDE  = [];

function matchesKeywords(entry) {
  const textRaw = [
    entry.title || "",
    entry.contentSnippet || entry.summary || "",
    Array.isArray(entry.categories) ? entry.categories.join(" ") : "",
    entry.link || ""
  ].join(" ");
  const hay = normalizeForMatch(textRaw);
  if (EXCLUDE.length && EXCLUDE.some(k => hay.includes(k))) return false;
  if (KEYWORDS.length && !KEYWORDS.some(k => hay.includes(k))) return false;
  return true;
}

// --- Link normalizálása deduplikációhoz (UTM, hash, stb. dobása) ---
function normalizeUrl(u = "") {
  try {
    const url = new URL(u);
    url.hash = "";
    const drop = new Set(["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid","mc_cid","mc_eid","ref"]);
    [...url.searchParams.keys()].forEach(k => { if (drop.has(k.toLowerCase())) url.searchParams.delete(k); });
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/,"")}${url.search ? `?${url.searchParams.toString()}` : ""}`;
  } catch { return ""; }
}

// ---------- Gist state ----------
async function loadState() {
  if (!GIST_ID) return { seen:new Set(), seenLinks:new Set() };
  const r = await fetch(`${GITHUB_API}/gists/${GIST_ID}`, FETCH_OPTS);
  if (!r.ok) throw new Error(`Gist GET failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const file = data.files?.[STATE_FILENAME]?.content;
  if (!file) return { seen:new Set(), seenLinks:new Set() };
  const parsed = JSON.parse(file);
  return {
    seen: new Set(parsed.seen || []),
    seenLinks: new Set(parsed.seen_links || [])
  };
}
async function saveState(state) {
  const files = { [STATE_FILENAME]: { content: JSON.stringify({
    seen: [...state.seen].sort(),
    seen_links: [...state.seenLinks].sort()
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

// ---------- Feeds ----------
async function readFeedsList(path="feeds.txt") {
  const raw = await fs.readFile(path, "utf8");
  return raw
    .split("\n")
    .map(s => s.split("#")[0].trim()) // inline komment támogatás
    .filter(s => s);
}

// ---------- Main ----------
async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !GIST_TOKEN) {
    throw new Error("Hiányzó env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, GIST_TOKEN kötelező.");
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling:false });
  const parser = new Parser({ timeout: 20000 });

  // kulcsszavak fájlból, env fallback
  const kwFromFile = await readListFile("keywords.txt");
  const exFromFile = await readListFile("exclude.txt");
  KEYWORDS = (kwFromFile.length ? kwFromFile : (process.env.KEYWORDS || "").split(/[,\n]/))
    .map(s => s.trim()).filter(Boolean).map(normalizeForMatch);
  EXCLUDE  = (exFromFile.length ? exFromFile : (process.env.EXCLUDE_KEYWORDS || "").split(/[,\n]/))
    .map(s => s.trim()).filter(Boolean).map(normalizeForMatch);
  if (DEBUG) {
    console.log("DEBUG KEYWORDS:", KEYWORDS);
    console.log("DEBUG EXCLUDE :", EXCLUDE);
  }

  const state = await loadState();
  const feeds = await readFeedsList();
  let sent = 0, skippedByExclude = 0, skippedByKeywords = 0;

  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const feedTitle = feed.title || url;
      const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);

      for (const e of [...items].reverse()) {
        const id = canonicalId(e);
        const nurl = normalizeUrl(e.link || "");

        // ID- vagy LINK-alapú deduplikáció
        if (state.seen.has(id) || (nurl && state.seenLinks.has(nurl))) continue;

        // kulcsszűrés
        const textForWhy = normalizeForMatch([e.title||"", e.contentSnippet||e.summary||""].join(" "));
        if (!matchesKeywords(e)) {
          if (EXCLUDE.length && EXCLUDE.some(k => textForWhy.includes(k))) skippedByExclude++;
          else if (KEYWORDS.length) skippedByKeywords++;
          continue;
        }

        const html = buildHTMLMessage(feedTitle, e);
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
