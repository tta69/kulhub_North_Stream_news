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
  sha256(e.id || e.guid || `${e.link || ""}|${e.title || ""}|${e.isoDate || e.pubDate || ""}`);

const escapeMd = (t = "") => t.replace(/([_*[\]()~`>#+-=|{}.!])/g, "\\$1");
const fmt = (feedTitle, e) => {
  const title = e.title || "Új bejegyzés";
  const link = e.link || "";
  let sum = (e.contentSnippet || e.summary || "").replace(/\s+/g, " ").trim();
  if (sum.length > 300) sum = sum.slice(0, 297) + "...";
  return sum
    ? `📰 *${escapeMd(title)}*\n_${escapeMd(feedTitle)}_\n\n${escapeMd(sum)}\n\n${link}`
    : `📰 *${escapeMd(title)}*\n_${escapeMd(feedTitle)}_\n\n${link}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readListFile(path) {
  try {
    const raw = await fs.readFile(path, "utf8");
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeForMatch(s) {
  // kisbetű + ékezetek eltávolítása (Node 20: Unicode property escapes OK)
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
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
  if (EXCLUDE.length && EXCLUDE.some((k) => hay.includes(k))) return false;
  if (KEYWORDS.length && !KEYWORDS.some((k) => hay.includes(k))) return false;
  return true;
}

async function loadState() {
  if (!GIST_ID) return { seen: new Set() };
  const r = await fetch(`${GITHUB_API}/gists/${GIST_ID}`, FETCH_OPTS);
  if (!r.ok) throw new Error(`Gist GET failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  const file = data.files?.[STATE_FILENAME]?.content;
  return { seen: new Set(file ? JSON.parse(file).seen || [] : []) };
}

async function saveState(state) {
  const files = {
    [STATE_FILENAME]: {
      content: JSON.stringify({ seen: [...state.seen].sort() }, null, 2)
    }
  };
  if (GIST_ID) {
    const r = await fetch(`${GITHUB_API}/gists/${GIST_ID}`, {
      method: "PATCH",
      ...FETCH_OPTS,
      body: JSON.stringify({ files })
    });
    if (!r.ok) throw new Error(`Gist PATCH failed: ${r.status} ${r.statusText}`);
  } else {
    const r = await fetch(`${GITHUB_API}/gists`, {
      method: "POST",
      ...FETCH_OPTS,
      body: JSON.stringify({ files, description: "Telegram RSS bot state", public: false })
    });
    if (!r.ok) throw new Error(`Gist POST failed: ${r.status} ${r.statusText}`);
    const created = await r.json();
    GIST_ID = created.id;
    console.log(`Created Gist with id: ${GIST_ID}`);
  }
}

async function readFeedsList(path = "feeds.txt") {
  const raw = await fs.readFile(path, "utf8");
  return raw.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

// ---------- Main ----------
async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !GIST_TOKEN) {
    throw new Error("Hiányzó env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, GIST_TOKEN kötelező.");
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  const parser = new Parser({ timeout: 20000 });

  // Kulcsszavak betöltése fájlból, fallback env-re
  const kwFromFile = await readListFile("keywords.txt");
  const exFromFile = await readListFile("exclude.txt");

  KEYWORDS = (kwFromFile.length ? kwFromFile : (process.env.KEYWORDS || "").split(/[,\n]/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeForMatch);

  EXCLUDE = (exFromFile.length ? exFromFile : (process.env.EXCLUDE_KEYWORDS || "").split(/[,\n]/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeForMatch);

  if (DEBUG) {
    console.log("DEBUG: KEYWORDS =", KEYWORDS);
    console.log("DEBUG: EXCLUDE  =", EXCLUDE);
  }

  const state = await loadState();
  const feeds = await readFeedsList();

  let sent = 0;
  let skippedByExclude = 0;
  let skippedByKeywords = 0;

  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const feedTitle = feed.title || url;
      const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);

      for (const e of [...items].reverse()) {
        const id = canonicalId(e);
        if (state.seen.has(id)) continue;

        const before = sent + skippedByExclude + skippedByKeywords;

        if (!matchesKeywords(e)) {
          // durva ok megállapítás (csak debug stathoz)
          const text = normalizeForMatch(
            [e.title || "", e.contentSnippet || e.summary || ""].join(" ")
          );
          if (EXCLUDE.length && EXCLUDE.some((k) => text.includes(k))) skippedByExclude++;
          else if (KEYWORDS.length) skippedByKeywords++;
          continue;
        }

        try {
          await bot.sendMessage(TELEGRAM_CHANNEL_ID, fmt(feedTitle, e), {
            parse_mode: "Markdown",
            disable_web_page_preview: false
          });
          state.seen.add(id);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
