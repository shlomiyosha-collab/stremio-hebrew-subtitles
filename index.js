const express = require("express");
const unzipper = require("unzipper");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;
const BASE_URL = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

const manifest = {
  id: "community.hebrew.subtitles",
  version: "1.3.1",
  name: "כתוביות בעברית",
  description: "כתוביות בעברית מ-OpenSubtitles ומ-Wizdom, ותרגום אוטומטי כשאין",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

const builder = new addonBuilder(manifest);
const HEB = ["heb", "he", "iw"];

// ---------- מקור 1: OpenSubtitles ----------
async function fetchOS(type, id, extra) {
  const extraStr = Object.keys(extra || {}).length
    ? "/" + new URLSearchParams(extra).toString()
    : "";
  const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraStr}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    console.error("OS status", res.status, url);
    return [];
  }
  const data = await res.json();
  return data.subtitles || [];
}

// ---------- מקור 2: Wizdom ----------
async function fromWizdom(type, id) {
  const [imdb, season, episode] = id.split(":");
  const res = await fetch(`https://wizdom.xyz/api/releases/${imdb}`, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) {
    console.error("Wizdom status", res.status);
    return [];
  }
  const data = await res.json();
  let subs = data.subs;
  if (type === "series" && season && episode) {
    subs = subs && subs[season] && subs[season][episode];
  }
  if (!subs) return [];
  const list = Array.isArray(subs) ? subs : Object.values(subs);
  return list
    .filter((s) => s && s.id)
    .map((s) => ({
      id: `[WIZDOM]${s.id}`,
      url: `${BASE_URL}/srt/${s.id}.srt`,
      lang: "heb"
    }));
}

// ---------- מקור 3: SubDL (דורש מפתח חינמי: SUBDL_API_KEY) ----------
const SUBDL_KEY = process.env.SUBDL_API_KEY;

async function subdlSearch(type, id, langs) {
  if (!SUBDL_KEY) return [];
  const [imdb, season, episode] = id.split(":");
  const p = new URLSearchParams({
    api_key: SUBDL_KEY,
    imdb_id: imdb,
    type: type === "series" ? "tv" : "movie",
    languages: langs,
    subs_per_page: "10"
  });
  const isEp = type === "series" && season && episode;
  if (isEp) {
    p.set("season_number", season);
    p.set("episode_number", episode);
  }
  const r = await fetch("https://api.subdl.com/api/v1/subtitles?" + p, {
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    console.error("SubDL status", r.status);
    return [];
  }
  const d = await r.json();
  const qs = isEp ? `?s=${season}&e=${episode}` : "";
  return (d.subtitles || [])
    .filter((x) => x && x.url)
    .map((x) => `${BASE_URL}/zip/${Buffer.from(x.url).toString("base64url")}.srt${qs}`);
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const [osRes, wzRes, sdRes] = await Promise.allSettled([
    fetchOS(type, id, extra),
    fromWizdom(type, id),
    subdlSearch(type, id, "HE")
  ]);
  const osAll = osRes.status === "fulfilled" ? osRes.value : [];
  const wz = wzRes.status === "fulfilled" ? wzRes.value : [];
  const sd = sdRes.status === "fulfilled" ? sdRes.value : [];
  if (osRes.status === "rejected") console.error("OS נכשל:", osRes.reason?.message);
  if (wzRes.status === "rejected") console.error("Wizdom נכשל:", wzRes.reason?.message);
  if (sdRes.status === "rejected") console.error("SubDL נכשל:", sdRes.reason?.message);

  const subtitles = [
    ...osAll
      .filter((s) => HEB.includes(s.lang))
      .map((s, i) => ({ id: `[OS]${s.id || i}`, url: s.url, lang: "heb" })),
    ...wz,
    ...sd.map((url, i) => ({ id: `[SUBDL]${i}`, url, lang: "heb" }))
  ];

  // אין כתובית בעברית? מוסיפים תרגום אוטומטי מהאנגלית (מתבצע רק כשבוחרים אותו)
  if (subtitles.length === 0) {
    let engUrl = (osAll.find((s) => s.lang === "eng" || s.lang === "en") || {}).url;
    if (!engUrl) {
      try {
        engUrl = (await subdlSearch(type, id, "EN"))[0];
      } catch (e) {
        console.error("SubDL EN:", e.message);
      }
    }
    if (engUrl) {
      const token = Buffer.from(engUrl).toString("base64url");
      subtitles.push({
        id: "[AUTO-GOOGLE]תרגום אוטומטי",
        url: `${BASE_URL}/auto/${token}.srt`,
        lang: "heb"
      });
    }
  }
  return { subtitles, cacheMaxAge: 1800 };
});

// ---------- תרגום אוטומטי ----------
function decodeText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

function parseSrt(text) {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti === -1) continue;
    const body = lines
      .slice(ti + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .trim();
    cues.push({ time: lines[ti], text: body });
  }
  return cues;
}

async function googleTranslate(text) {
  const q = encodeURIComponent(text);
  const errors = [];
  // ניסיון 1: ממשק gtx
  try {
    const r = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q=${q}`,
      { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (r.ok) {
      const d = await r.json();
      const out = d[0].map((x) => x[0]).join("");
      if (out) return out;
    } else errors.push("gtx " + r.status);
  } catch (e) {
    errors.push("gtx " + e.message);
  }
  // ניסיון 2: ממשק נוסף של גוגל
  try {
    const r = await fetch(
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=he&q=${q}`,
      { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (r.ok) {
      const d = await r.json();
      const first = Array.isArray(d) ? d[0] : d;
      const out = Array.isArray(first) ? first[0] : first;
      if (typeof out === "string" && out) return out;
    } else errors.push("dict " + r.status);
  } catch (e) {
    errors.push("dict " + e.message);
  }
  throw new Error("translate failed: " + errors.join(" | "));
}

const SEP = "\n@@@\n";
async function translateChunk(texts) {
  try {
    const out = (await googleTranslate(texts.join(SEP))).split(/\s*@@@\s*/);
    if (out.length === texts.length) return out;
  } catch (e) {
    console.error("chunk:", e.message);
  }
  // גיבוי: שורה אחר שורה
  const res = [];
  for (const t of texts) {
    try {
      res.push(await googleTranslate(t));
    } catch {
      res.push(null);
    }
  }
  return res;
}

async function translateCues(cues) {
  const chunks = [];
  let cur = [];
  let len = 0;
  cues.forEach((c, i) => {
    if (cur.length && (len + c.text.length > 3000 || cur.length >= 40)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += c.text.length + 5;
  });
  if (cur.length) chunks.push(cur);

  const results = new Array(cues.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const idxs = chunks[next++];
      const out = await translateChunk(idxs.map((i) => cues[i].text));
      idxs.forEach((cueIdx, k) => (results[cueIdx] = out[k]));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const failed = results.filter((x) => !x).length;
  if (failed > cues.length * 0.2) {
    throw new Error(`translation failed for ${failed}/${cues.length} cues`);
  }
  return results;
}

function buildSrt(cues, translated) {
  return (
    cues
      .map((c, i) => {
        const t = (translated[i] || c.text)
          .split("\n")
          .map((l) => "\u200F" + l.trim())
          .join("\n");
        return `${i + 1}\n${c.time}\n${t}`;
      })
      .join("\n\n") + "\n"
  );
}

const autoCache = new Map(); // token -> Promise<string>
function getAuto(token) {
  if (autoCache.has(token)) return autoCache.get(token);
  const p = (async () => {
    const url = Buffer.from(token, "base64url").toString();
    if (!/^https?:\/\//.test(url)) throw new Error("bad url");
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("source " + r.status);
    const cues = parseSrt(decodeText(Buffer.from(await r.arrayBuffer())));
    if (!cues.length) throw new Error("empty srt");
    return buildSrt(cues, await translateCues(cues));
  })();
  autoCache.set(token, p);
  p.catch(() => autoCache.delete(token));
  if (autoCache.size > 30) autoCache.delete(autoCache.keys().next().value);
  return p;
}

// ---------- שרת ----------
const app = express();

// בדיקת אבחון: /debug/series/tt5998226:1:1
app.get("/debug/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  const out = { baseUrl: BASE_URL };
  try {
    const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const t = await r.text();
    out.opensubtitles = { status: r.status, total: 0, langs: [] };
    try {
      const subs = JSON.parse(t).subtitles || [];
      out.opensubtitles.total = subs.length;
      out.opensubtitles.langs = [...new Set(subs.map((x) => x.lang))];
    } catch {
      out.opensubtitles.body = t.slice(0, 200);
    }
  } catch (e) {
    out.opensubtitles = { error: e.message };
  }
  try {
    const imdb = id.split(":")[0];
    const r = await fetch(`https://wizdom.xyz/api/releases/${imdb}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    out.wizdom = { status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e) {
    out.wizdom = { error: e.message };
  }
  try {
    out.subdl = { hasKey: !!SUBDL_KEY };
    if (SUBDL_KEY) {
      out.subdl.hebrew = (await subdlSearch(type, id, "HE")).length;
      out.subdl.english = (await subdlSearch(type, id, "EN")).length;
    }
  } catch (e) {
    out.subdl = { error: e.message };
  }
  res.json(out);
});

// בדיקת תרגום: /debug-translate
app.get("/debug-translate", async (req, res) => {
  try {
    res.json({ ok: true, result: await googleTranslate("Hello, how are you?") });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/zip/:token.srt", async (req, res) => {
  try {
    const path = Buffer.from(req.params.token, "base64url").toString();
    if (!/^\/subtitle\/[\w.\-%]+\.zip$/.test(path)) return res.status(400).send("bad");
    const r = await fetch("https://dl.subdl.com" + path, {
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return res.status(502).send("download failed");
    const dir = await unzipper.Open.buffer(Buffer.from(await r.arrayBuffer()));
    const srts = dir.files.filter((f) => /\.srt$/i.test(f.path));
    if (!srts.length) return res.status(404).send("no srt");
    let file = srts[0];
    const sn = Number(req.query.s);
    const en = Number(req.query.e);
    if (srts.length > 1 && sn && en) {
      const re = new RegExp(`s0*${sn}[ ._-]*e0*${en}(?!\\d)|\\b${sn}x0*${en}(?!\\d)`, "i");
      file = srts.find((f) => re.test(f.path)) || file;
    }
    const raw = await file.buffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder("windows-1255").decode(raw);
    }
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(text);
  } catch (e) {
    console.error("zip error:", e.message);
    res.status(500).send("error");
  }
});

app.get("/auto/:token.srt", async (req, res) => {
  try {
    const srt = await getAuto(req.params.token);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(srt);
  } catch (e) {
    console.error("auto error:", e.message);
    res.status(500).send("error");
  }
});

app.get("/srt/:id.srt", async (req, res) => {
  try {
    const r = await fetch(`https://wizdom.xyz/api/files/sub/${req.params.id}`, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) return res.status(502).send("download failed");
    const zipBuf = Buffer.from(await r.arrayBuffer());
    const dir = await unzipper.Open.buffer(zipBuf);
    const file = dir.files.find((f) => /\.srt$/i.test(f.path));
    if (!file) return res.status(404).send("no srt in zip");
    const raw = await file.buffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      text = new TextDecoder("windows-1255").decode(raw);
    }
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.send(text);
  } catch (e) {
    console.error("srt error:", e.message);
    res.status(500).send("error");
  }
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`התוסף רץ: ${BASE_URL}/manifest.json`);
});
