// Holt alle nicht-adulten Manhwas, Manhuas und Mangas von AniList und schreibt sie
// als kompakte JSON-Dateien nach <ausgabeordner>/data. Läuft dreimal täglich per GitHub Actions.
// Nutzung: node scripts/fetch-data.mjs site
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(process.argv[2] || "site", "data");
const COUNTRIES = ["KR", "CN", "JP", "TW"];
const DELAY_MS = 2200; // AniList erlaubt derzeit etwa 30 Anfragen pro Minute
const STATUS = { RELEASING: 0, FINISHED: 1, HIATUS: 2, NOT_YET_RELEASED: 3, CANCELLED: 4 };

const QUERY = `query($country:CountryCode,$after:Int){
  Page(page:1,perPage:50){
    media(type:MANGA,countryOfOrigin:$country,isAdult:false,sort:ID,id_greater:$after){
      id title{ romaji english } genres tags{ name rank isMediaSpoiler } status chapters volumes
      averageScore popularity trending startDate{ year } coverImage{ medium color }
      externalLinks{ site url type language }
    } } }`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function query(variables, attempt = 1) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables })
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 8) throw new Error(`AniList antwortet mit ${res.status}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 30000 * attempt;
    console.log(`  ${res.status}, warte ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    return query(variables, attempt + 1);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`AniList HTTP ${res.status}, keine JSON-Antwort: ${text.slice(0, 300)}`); }
  if (!res.ok || json.errors) throw new Error(`AniList HTTP ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 600)}`);
  return json.data.Page.media;
}

const row = m => {
  const links = (m.externalLinks || []).filter(l => l.type !== "SOCIAL")
    .map(l => [l.site, l.url, l.language || 0, l.type === "STREAMING" ? 0 : l.type]);
  const tags = (m.tags || []).filter(t => t.rank >= 50 && !t.isMediaSpoiler).map(t => t.name);
  const a = [m.id, m.title.english || 0, m.title.romaji, m.genres, tags, STATUS[m.status] ?? -1,
    m.chapters || 0, m.volumes || 0, m.averageScore || 0, m.popularity || 0, m.trending || 0,
    m.startDate?.year || 0, m.coverImage?.medium || 0, m.coverImage?.color || 0, links.length ? links : 0];
  while (a.length && !a[a.length - 1]) a.pop(); // leere Felder am Ende weglassen
  return a;
};

async function main() {
await mkdir(OUT, { recursive: true });
const counts = {};
for (const country of COUNTRIES) {
  const rows = [];
  let after = 0;
  for (;;) {
    const media = await query({ country, after });
    if (!after) console.log(`::notice title=${country}::Erste Seite geladen (${media.length} Titel)`);
    rows.push(...media.map(row));
    if (media.length < 50) break;
    after = media[media.length - 1].id;
    if (rows.length % 1000 === 0) console.log(`${country}: ${rows.length}`);
    await sleep(DELAY_MS);
  }
  rows.sort((a, b) => (b[9] || 0) - (a[9] || 0));
  await writeFile(join(OUT, `${country}.json`), JSON.stringify(rows));
  counts[country] = rows.length;
  console.log(`${country}: ${rows.length} Titel gespeichert`);
  await sleep(DELAY_MS);
}
await writeFile(join(OUT, "meta.json"), JSON.stringify({ updated: new Date().toISOString(), countries: COUNTRIES, counts }));
console.log("Fertig", counts);
}

// Fehler als GitHub-Annotation ausgeben, damit sie in der Übersicht des Laufs sichtbar sind
main().catch(e => {
  console.log(`::error title=Abholen fehlgeschlagen::${String((e && e.stack) || e).replace(/\n/g, " | ").slice(0, 900)}`);
  process.exit(1);
});
