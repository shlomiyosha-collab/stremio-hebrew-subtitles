const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// מקורות כתוביות (אפשר להוסיף עוד בהמשך)
const SOURCES = [
  "https://opensubtitles-v3.strem.io"
];

const manifest = {
  id: "community.hebrew.subtitles",
  version: "1.0.0",
  name: "כתוביות בעברית",
  description: "מביא כתוביות בעברית לסרטים וסדרות",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: []
};

const builder = new addonBuilder(manifest);

async function fetchFromSource(base, type, id, extra) {
  // extra למשל: { filename, videoHash, videoSize }
  const extraStr = Object.keys(extra || {}).length
    ? "/" + new URLSearchParams(extra).toString()
    : "";
  const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}${extraStr}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.subtitles || []).filter(
    (s) => s.lang === "heb" || s.lang === "he" || s.lang === "iw"
  );
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  try {
    const results = await Promise.allSettled(
      SOURCES.map((src) => fetchFromSource(src, type, id, extra))
    );
    const subtitles = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .map((s, i) => ({
        id: s.id || `heb-${i}`,
        url: s.url,
        lang: "heb"
      }));
    return { subtitles, cacheMaxAge: 3600 };
  } catch (e) {
    console.error(e);
    return { subtitles: [] };
  }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`התוסף רץ: http://127.0.0.1:${port}/manifest.json`);
