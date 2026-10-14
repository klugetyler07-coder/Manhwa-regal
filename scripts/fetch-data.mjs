// Holt alle nicht-adulten Manhwas, Manhuas und Mangas von AniList und schreibt sie
// als kompakte JSON-Dateien nach <ausgabeordner>/data. Läuft dreimal täglich per GitHub Actions.
// Nutzung: node scripts/fetch-data.mjs site
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(process.argv[2] || "site", "data");
const COUNTRIES = ["KR", "CN", "JP", "TW"];
const DELAY_MS = 2200; // AniList erlaubt derzeit etwa 30 Anfragen pro Minute
const STATUS = { RELEASING: 0, FINISHED: 1, HIATUS: 2, NOT_YET_RELEASED: 3, CANCELLED: 4 };

// AniList liefert pro Abfrage höchstens 5000 Einträge. Deshalb wird nach Beliebtheit
// (und notfalls nach Status) in Teilmengen unter 5000 aufgeteilt.
const FILTER = `countryOfOrigin:$country,isAdult:false,format_in:[MANGA,ONE_SHOT],popularity_greater:$popGt,popularity_lesser:$popLt,status:$status,startDate_greater:$dateGt,startDate_lesser:$dateLt`;
const VARS = `$country:CountryCode,$popGt:Int,$popLt:Int,$status:MediaStatus,$dateGt:FuzzyDateInt,$dateLt:FuzzyDateInt`;
// pageInfo.total ist bei AniList unzuverlässig (meldet oft pauschal 5000). Stattdessen wird
// die letzte erlaubte Seite (100 × 50) abgefragt: ist sie voll, ist die Teilmenge zu groß.
const PROBE = `query(${VARS}){ Page(page:100,perPage:50){ media(${FILTER},sort:ID){ id } } }`;
const QUERY = `query(${VARS},$page:Int){
  Page(page:$page,perPage:50){
    pageInfo{ hasNextPage }
    media(${FILTER},sort:ID){
      id title{ romaji english } genres tags{ name rank isMediaSpoiler } status chapters volumes
      averageScore popularity trending startDate{ year } coverImage{ medium color }
      externalLinks{ site url type language }
    } } }`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function query(variables, attempt = 1, q = QUERY) {
  let res, text;
  try {
    res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // AniList behandelt null als Wert („Illegal operator and value combination“), deshalb weglassen
      body: JSON.stringify({ query: q, variables: Object.fromEntries(Object.entries(variables).filter(([, x]) => x != null)) }),
      signal: AbortSignal.timeout(60000)
    });
    text = await res.text();
  } catch (e) {
    // Netzwerkaussetzer („fetch failed“, „terminated“, Zeitüberschreitung) einfach wiederholen
    if (attempt > 10) throw e;
    console.log(`  Netzwerkfehler (${e.message}), neuer Versuch in ${15 * attempt} s`);
    await sleep(15000 * attempt);
    return query(variables, attempt + 1, q);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 10) throw new Error(`AniList antwortet mit ${res.status}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 30000 * attempt;
    console.log(`  ${res.status}, warte ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    return query(variables, attempt + 1, q);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`AniList HTTP ${res.status}, keine JSON-Antwort: ${text.slice(0, 300)}`); }
  if (!res.ok || json.errors) throw new Error(`AniList HTTP ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 600)}`);
  return json.data.Page;
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

async function fits(v) {
  const page = await query(v, 1, PROBE);
  await sleep(DELAY_MS);
  return page.media.length < 50;
}

const YEAR = new Date().getUTCFullYear();
const YEARS = [[null, 19900000], ...Array.from({ length: YEAR + 2 - 1990 }, (_, i) => [(1990 + i) * 10000 - 1, (1991 + i) * 10000])];

// Zerlegt [lo, hi] (Beliebtheit, beide inklusive) so lange, bis jede Teilmenge unter 5000 liegt;
// reicht das nicht, zusätzlich nach Status und dann nach Erscheinungsjahr
async function partitions(country, lo, hi, status = null, date = null) {
  const v = { country, popGt: lo > 0 ? lo - 1 : null, popLt: hi + 1, status, dateGt: date?.[0], dateLt: date?.[1] };
  if (await fits(v)) return [v];
  if (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    return [...await partitions(country, lo, mid, status), ...await partitions(country, mid + 1, hi, status)];
  }
  if (!status) {
    const out = [];
    for (const st of Object.keys(STATUS)) out.push(...await partitions(country, lo, hi, st));
    return out;
  }
  if (!date) {
    // Titel ohne Startdatum fallen durch alle Jahresfilter, deshalb zusätzlich die ungefilterte Menge (gekappt)
    const out = [v];
    for (const d of YEARS) out.push(...await partitions(country, lo, hi, status, d));
    return out;
  }
  console.log(`::warning title=${country}::Beliebtheit ${lo}, Status ${status}, Jahr ${date[1] / 10000 - 1}: mehr als 5000 Titel, nur die ersten 5000 geholt`);
  return [v];
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const counts = {};
  for (const country of COUNTRIES) {
    const byId = new Map();
    try {
      for (const v of await partitions(country, 0, 5000000)) {
        for (let page = 1; page * 50 <= 5000; page++) {
          const { media, pageInfo } = await query({ ...v, page });
          media.forEach(m => byId.set(m.id, row(m)));
          await sleep(DELAY_MS);
          if (!pageInfo.hasNextPage || !media.length) break;
        }
        console.log(`${country}: ${byId.size}`);
      }
    } catch (e) {
      // Ein Land, das abbricht, soll die übrigen nicht mitreißen; was bis dahin geholt wurde, wird gespeichert
      console.log(`::warning title=${country} unvollständig::${String((e && e.stack) || e).replace(/\n/g, " | ").slice(0, 600)}`);
    }
    const rows = [...byId.values()].sort((a, b) => (b[9] || 0) - (a[9] || 0));
    await writeFile(join(OUT, `${country}.json`), JSON.stringify(rows));
    counts[country] = rows.length;
    console.log(`::notice title=${country}::${rows.length} Titel gespeichert`);
  }
  if (!Object.values(counts).some(Boolean)) throw new Error("Keine Titel geholt");
  await writeFile(join(OUT, "meta.json"), JSON.stringify({ updated: new Date().toISOString(), countries: COUNTRIES, counts }));
  console.log("Fertig", counts);
}

// Fehler als GitHub-Annotation ausgeben, damit sie in der Übersicht des Laufs sichtbar sind
main().catch(e => {
  console.log(`::error title=Abholen fehlgeschlagen::${String((e && e.stack) || e).replace(/\n/g, " | ").slice(0, 900)}`);
  process.exit(1);
});
