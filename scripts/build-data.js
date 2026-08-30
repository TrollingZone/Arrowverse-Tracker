// Fetches the Arrowverse episode list from arrowverse.info and
// converts it into a compact JSON file the web app can load.
//
// Usage:  node scripts/build-data.js
//
// The script deliberately avoids third party deps so it can run
// with a plain Node install.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeEpisodes } = require('./normalize-data');

const SOURCE_URL = 'https://arrowverse.info/';
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'episodes.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'arrowverse-tracker-builder' } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function decodeEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function parseEpisodes(html) {
  // Each row: <tr class="episode SHOW"> <td>#</td> <td>Series</td>
  //            <td>SxxEyy</td> <td>Name</td> <td>Air Date</td> <td>...</td>
  const rowRegex = /<tr class="episode ([^"]+)">([\s\S]*?)<\/tr>/g;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const linkRegex = /<a\s+href=(?:"([^"]+)"|([^\s>]+))/;

  const episodes = [];
  let match;
  while ((match = rowRegex.exec(html))) {
    const showSlug = match[1].trim();
    const rowHtml = match[2];
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml))) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue;

    const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '').trim());
    const number = parseInt(stripTags(cells[0]), 10);
    const series = stripTags(cells[1]);
    const code = stripTags(cells[2]);
    const title = stripTags(cells[3]);
    const airDate = stripTags(cells[4]);

    let sourceUrl = null;
    const linkMatch = cells[5] && cells[5].match(linkRegex);
    if (linkMatch) {
      const href = linkMatch[1] || linkMatch[2];
      sourceUrl = href.replace(/^\.\//, 'https://arrowverse.info/');
    }

    const seasonMatch = code.match(/S(\d{2})E(\d{1,3}|—)/);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    const episode = seasonMatch && seasonMatch[2] !== '—' ? parseInt(seasonMatch[2], 10) : null;

    episodes.push({
      id: number,
      show: showSlug,
      series,
      code,
      season,
      episode,
      title,
      airDate,
      sourceUrl,
    });
  }
  return episodes;
}

async function main() {
  console.log('Fetching', SOURCE_URL);
  const html = await fetch(SOURCE_URL);
  const rawEpisodes = parseEpisodes(html);
  if (rawEpisodes.length === 0) throw new Error('No episodes parsed - layout may have changed.');

  // The upstream table has duplicate rows, malformed codes and at least one
  // missing episode. normalize-data.js repairs all of that, so a re-scrape
  // can't quietly undo the fixes. See that file for the details.
  const { episodes, shows, notes } = normalizeEpisodes(rawEpisodes);

  const payload = {
    source: SOURCE_URL,
    generatedAt: new Date().toISOString(),
    shows,
    episodes,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload));

  console.log(`Scraped ${rawEpisodes.length} rows, kept ${episodes.length} after cleanup.`);
  for (const n of notes) {
    if (n.type === 'duplicate-removed') {
      console.log(`  removed duplicate ${n.show} ${n.code} ${JSON.stringify(n.removedTitle)}`);
    } else if (n.type === 'code-repaired') {
      console.log(`  repaired code ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)} (${JSON.stringify(n.title)})`);
    } else if (n.type === 'episode-added') {
      console.log(`  added missing ${n.show} ${n.code} ${JSON.stringify(n.title)}`);
    } else if (n.type === 'title-overridden') {
      console.log(`  retitled ${n.show} ${n.code} ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`);
    }
  }
  console.log(`Wrote ${episodes.length} episodes across ${shows.length} shows to ${OUTPUT_PATH}`);

  if (notes.some((n) => n.type === 'duplicate-removed' || n.type === 'episode-added')) {
    console.log('\nNOTE: episode ids were renumbered. If you re-scrape after');
    console.log('watching episodes, check data/progress.json still lines up.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
