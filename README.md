# Manhwa Regal

Suchmaschine für Manhwas, Manhuas und Mangas mit englischer Ausgabe. Die Seite zeigt nur Katalogdaten
(Titel, Genres, Status, Kapitelzahl, Cover von AniList) und verlinkt auf offizielle Leseseiten.
Kapitel werden hier nicht gehostet.

## So funktioniert es

- `index.html` ist die ganze Website.
- `scripts/fetch-data.mjs` holt alle Titel von AniList und schreibt sie nach `site/data/`.
- `.github/workflows/update.yml` führt das dreimal täglich aus (04:00, 12:00, 20:00 UTC) und
  veröffentlicht die Seite auf GitHub Pages. Von Hand starten: Actions → „Titel aktualisieren und
  veröffentlichen“ → Run workflow.

Einmalig einschalten: Settings → Pages → Source: **GitHub Actions**.
