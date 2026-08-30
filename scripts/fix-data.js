'use strict';

// Applies scripts/normalize-data.js to the already-committed data files,
// without re-scraping arrowverse.info.
//
//   node scripts/fix-data.js --dry-run   # report only, write nothing
//   node scripts/fix-data.js             # write episodes.json + progress.json
//
// Backups are written next to the originals as *.bak-<timestamp>.
// Stop the server before running this: it holds progress.json in memory and
// would overwrite the migrated file on its next save.

const fs = require('fs');
const path = require('path');
const { normalizeEpisodes } = require('./normalize-data');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EPISODES_PATH = path.join(DATA_DIR, 'episodes.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'progress.json');

const dryRun = process.argv.includes('--dry-run');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${p}.bak-${stamp}`;
  fs.copyFileSync(p, dest);
  return dest;
}

function pct(watched, total) {
  return total ? ((watched / total) * 100).toFixed(2) + '%' : '0%';
}

function main() {
  const before = readJson(EPISODES_PATH);
  const beforeCount = before.episodes.length;

  const { episodes, shows, idMap, notes } = normalizeEpisodes(before.episodes);

  const removed = notes.filter((n) => n.type === 'duplicate-removed');
  const repaired = notes.filter((n) => n.type === 'code-repaired');
  const added = notes.filter((n) => n.type === 'episode-added');
  const retitled = notes.filter((n) => n.type === 'title-overridden');

  // ---- report -------------------------------------------------------------
  console.log('');
  console.log('=========================================================');
  console.log(' Arrowverse Tracker - data repair' + (dryRun ? ' (DRY RUN)' : ''));
  console.log('=========================================================');
  console.log(` source          : ${before.source}`);
  console.log(` scraped at      : ${before.generatedAt}`);
  console.log(` episodes before : ${beforeCount}`);
  console.log(` episodes after  : ${episodes.length}`);
  console.log('');

  console.log(`--- REMOVED (${removed.length}) duplicate Show+Season+Episode rows ---`);
  for (const n of removed) {
    console.log(`  - id ${n.oldId}  ${n.show} ${n.code}  ${JSON.stringify(n.removedTitle)}  (${n.airDate})`);
    console.log(`      kept id ${n.keptOldId} ${JSON.stringify(n.keptTitle)}`);
  }
  if (!removed.length) console.log('  (none)');
  console.log('');

  console.log(`--- CHANGED (${repaired.length}) malformed episode codes ---`);
  for (const n of repaired) {
    console.log(`  ~ id ${n.oldId}  ${n.show}  ${JSON.stringify(n.title)}`);
    console.log(`      code ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}  (season ${n.season}, episode ${n.episode})`);
  }
  if (!repaired.length) console.log('  (none)');
  console.log('');

  console.log(`--- ADDED (${added.length}) episodes missing from the source ---`);
  for (const n of added) {
    console.log(`  + ${n.show} ${n.code}  ${JSON.stringify(n.title)}  (${n.airDate})`);
  }
  if (!added.length) console.log('  (none)');
  console.log('');

  console.log(`--- CHANGED (${retitled.length}) titles ---`);
  for (const n of retitled) {
    console.log(`  ~ id ${n.oldId}  ${n.show} ${n.code}`);
    console.log(`      ${JSON.stringify(n.from)} -> ${JSON.stringify(n.to)}`);
    console.log(`      reason: ${n.reason}`);
  }
  if (!retitled.length) console.log('  (none)');
  console.log('');

  // ---- id shifts ----------------------------------------------------------
  let firstShifted = null;
  let shiftedCount = 0;
  for (const [oldId, newId] of idMap) {
    if (oldId !== newId) {
      shiftedCount++;
      if (firstShifted === null || oldId < firstShifted) firstShifted = oldId;
    }
  }
  console.log('--- ID RENUMBERING ---');
  console.log(`  rows whose id changed : ${shiftedCount}`);
  console.log(`  lowest id affected    : ${firstShifted === null ? 'n/a' : firstShifted}`);
  console.log(`  ids below that        : unchanged`);
  console.log('');

  // ---- per-show counts ----------------------------------------------------
  const beforeByShow = new Map(before.shows.map((s) => [s.slug, s.count]));
  console.log('--- PER-SHOW COUNTS (only shows that changed) ---');
  let anyShowChanged = false;
  for (const s of shows) {
    const was = beforeByShow.get(s.slug);
    if (was !== s.count) {
      anyShowChanged = true;
      console.log(`  ${s.name}: ${was} -> ${s.count}`);
    }
  }
  if (!anyShowChanged) console.log('  (none)');
  console.log('');

  // ---- progress migration -------------------------------------------------
  let progress = null;
  let progressReport = null;
  if (fs.existsSync(PROGRESS_PATH)) {
    progress = readJson(PROGRESS_PATH);
    const oldWatched = Array.isArray(progress.watched) ? progress.watched : [];

    const migrated = [];
    const dropped = [];
    for (const oldId of oldWatched) {
      const newId = idMap.get(oldId);
      if (newId === undefined) dropped.push(oldId);
      else migrated.push(newId);
    }
    const newWatched = [...new Set(migrated)].sort((a, b) => a - b);

    const oldHistory = Array.isArray(progress.history) ? progress.history : [];
    const newHistory = oldHistory.map((h) => {
      if (h && typeof h.id === 'number') {
        const mapped = idMap.get(h.id);
        return mapped === undefined ? { ...h, id: h.id, orphaned: true } : { ...h, id: mapped };
      }
      return h;
    });

    const unchangedIds = oldWatched.filter((id) => idMap.get(id) === id).length;

    progressReport = {
      before: { watched: oldWatched.length, total: beforeCount },
      after: { watched: newWatched.length, total: episodes.length },
      dropped,
      unchangedIds,
    };

    progress = {
      ...progress,
      watched: newWatched,
      history: newHistory,
      version: (progress.version || 0) + 1,
      updatedAt: new Date().toISOString(),
    };

    console.log('--- PROGRESS ---');
    console.log(`  watched before : ${progressReport.before.watched} / ${progressReport.before.total}  (${pct(progressReport.before.watched, progressReport.before.total)})`);
    console.log(`  watched after  : ${progressReport.after.watched} / ${progressReport.after.total}  (${pct(progressReport.after.watched, progressReport.after.total)})`);
    console.log(`  watched ids left untouched by renumbering : ${progressReport.unchangedIds}/${progressReport.before.watched}`);
    console.log(`  watched ids dropped (pointed at a removed duplicate) : ${dropped.length ? dropped.join(', ') : 'none'}`);
    console.log('');
  }

  // ---- integrity checks ---------------------------------------------------
  const problems = [];
  const seenKey = new Set();
  const seenId = new Set();
  for (const ep of episodes) {
    const key = `${ep.show}|S${ep.season}|E${ep.episode}`;
    if (seenKey.has(key)) problems.push(`duplicate remains: ${key}`);
    seenKey.add(key);
    if (seenId.has(ep.id)) problems.push(`duplicate id: ${ep.id}`);
    seenId.add(ep.id);
    if (!/^S\d{2}E\d{2}$/.test(ep.code)) problems.push(`bad code on id ${ep.id}: ${ep.code}`);
  }
  // gaps inside a season (episode 0 = special, excluded)
  const bySeason = new Map();
  for (const ep of episodes) {
    if (!ep.episode) continue;
    const k = `${ep.show}|S${ep.season}`;
    if (!bySeason.has(k)) bySeason.set(k, new Set());
    bySeason.get(k).add(ep.episode);
  }
  for (const [k, set] of bySeason) {
    const max = Math.max(...set);
    const missing = [];
    for (let i = 1; i <= max; i++) if (!set.has(i)) missing.push(i);
    if (missing.length) problems.push(`${k} still missing E${missing.join(', E')}`);
  }

  console.log('--- INTEGRITY CHECK ---');
  if (problems.length) {
    for (const p of problems) console.log(`  FAIL  ${p}`);
  } else {
    console.log('  OK  no duplicate ids, no duplicate show+season+episode,');
    console.log('      all codes match SxxEyy, no gaps inside any season');
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run - nothing written.');
    return;
  }

  const episodeBackup = backup(EPISODES_PATH);
  writeJsonAtomic(EPISODES_PATH, {
    ...before,
    normalizedAt: new Date().toISOString(),
    shows,
    episodes,
  });
  console.log(`Wrote ${EPISODES_PATH}`);
  console.log(`  backup: ${episodeBackup}`);

  if (progress) {
    const progressBackup = backup(PROGRESS_PATH);
    writeJsonAtomic(PROGRESS_PATH, progress);
    console.log(`Wrote ${PROGRESS_PATH}`);
    console.log(`  backup: ${progressBackup}`);
  }
  console.log('');
}

main();
