
const express = require("express");
const unzipper = require("unzipper");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 7000;
// Render מגדיר את זה אוטומטית. מקומית: כתובת ה-localhost
const BASE_URL = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/$/, "");

const manifest = {
  id: "community.hebrew.subtitles",
  version: "1.1.0",
  name: "כתוביות בעברית",
  description: "כתוביות בעברית מ-OpenSubtitles ומ-Wizdom",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

const builder = new addonBuilder(manifest);

// ---------- מקור 1: OpenSubtitles ----------
async function fromOpenSubtitles(type, id, extra) {
  const extraStr = Object.keys(extra || {}).length
    ? "/" + new URLSearchParams(extra).toString()
    : "";
  const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraStr}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.subtitles || [])
    .filter((s) => ["heb", "he", "iw"].includes(s.lang))
    .map((s, i) => ({ id: `[OS]${s.id || i}`, url: s.url, lang: "heb" }));
}

// ---------- מקור 2: Wizdom ----------
async function fromWizdom(type, id) {
  const [imdb, season, episode] = id.split(":");
  const res = await fetch(`https://wizdom.xyz/api/releases/${imdb}`, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) return [];
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

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const results = await Promise.allSettled([
    fromOpenSubtitles(type, id, extra),
    fromWizdom(type, id)
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`מקור ${i} נכשל:`, r.reason?.message);
  });
  const subtitles = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);
  return { subtitles, cacheMaxAge: 3600 };
});

// ---------- שרת ----------
const app = express();

// Wizdom מחזיר ZIP. כאן מחלצים את ה-SRT ומחזירים אותו כ-UTF-8
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
