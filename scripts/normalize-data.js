'use strict';

// ---------------------------------------------------------------------------
// Data-quality layer for the arrowverse.info scrape.
//
// Upstream source: https://arrowverse.info/ (see scripts/build-data.js).
// That table ships three defects that make the episode count untrustworthy:
//
//   1. Duplicate rows for the same Show + Season + Episode, where the copies
//      differ only in title punctuation ("Shiv: Part 2" vs "Shiv Part Two").
//      These inflate the total.
//   2. Pre-season crossover specials are given an em-dash instead of an
//      episode number ("S05E0—"), which is not a parseable code.
//   3. At least one episode is missing outright (Stargirl S01E11).
//
// This module is applied by BOTH build-data.js (immediately after scraping)
// and fix-data.js (to the committed data/episodes.json), so re-running the
// scraper can never silently re-introduce the defects.
// ---------------------------------------------------------------------------

// Episodes the upstream table omits entirely. Verified against Wikipedia's
// Stargirl (TV series) episode list and the Stargirl Fandom wiki:
// "Shining Knight" is the 11th episode of season 1, released on DC Universe
// on July 27, 2020 (the dataset uses DC Universe air dates, not CW +1 day).
const MISSING_EPISODES = [
  {
    show: 'stargirl',
    series: 'Stargirl',
    season: 1,
    episode: 11,
    title: 'Shining Knight',
    airDate: 'July 27, 2020',
    // The per-episode Wikipedia deep links that arrowverse.info generates for
    // Stargirl are all dead (they 404, including for the neighbouring rows),
    // so point at the series page, which resolves.
    sourceUrl: 'https://en.wikipedia.org/wiki/Stargirl_(TV_series)',
  },
];

// Title corrections, keyed by show/season/episode so they apply no matter
// which of a pair of duplicate rows survives deduplication.
//
// Only used for internal consistency, NOT to "correct" official titles.
// Upstream carries both "Shiv: Part 1" and "Shiv Part Two" styling for the
// four Stargirl two-parters; after dedup that left three rows on the
// colon+numeral pattern and one on the spelled-out pattern. This aligns the
// odd one out. (The CW's own listings use a third style again -- "Shiv,
// Part 1" and "Stars and S.T.R.I.P.E. Part 1" -- so there is no single
// canonical form to defer to here; consistency is the achievable goal.)
const TITLE_OVERRIDES = [
  {
    show: 'stargirl',
    season: 1,
    episode: 13,
    to: 'Stars & S.T.R.I.P.E.: Part 2',
    reason: 'match the colon+numeral styling used by S01E07, S01E08 and S01E12',
  },
];

const WELL_FORMED_CODE = /^S\d{2}E\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Repairs codes like "S05E0—" -> "S05E00". Any non-digit junk in the episode
// slot collapses to episode 0, which is the conventional "special that airs
// outside the numbered season" slot.
function repairCodes(episodes, notes) {
  for (const ep of episodes) {
    if (WELL_FORMED_CODE.test(ep.code || '')) continue;
    const m = (ep.code || '').match(/^S(\d{1,2})E(.*)$/);
    if (!m) continue;

    const season = Number(m[1]);
    const digits = m[2].replace(/\D/g, '');
    const episode = digits === '' ? 0 : Number(digits);
    const fixed = `S${pad2(season)}E${pad2(episode)}`;

    notes.push({
      type: 'code-repaired',
      oldId: ep.id,
      show: ep.show,
      title: ep.title,
      from: ep.code,
      to: fixed,
      season,
      episode,
    });

    ep.code = fixed;
    ep.season = season;
    ep.episode = episode;
  }
}

// Keeps the first occurrence of each Show + Season + Episode and records the
// dropped rows. First-occurrence is a deterministic rule that preserves the
// upstream ordering.
function dropDuplicates(episodes, notes) {
  const seen = new Map();
  const kept = [];

  for (const ep of episodes) {
    const key = `${ep.show}|S${ep.season}|E${ep.episode}`;
    const existing = seen.get(key);
    if (existing) {
      notes.push({
        type: 'duplicate-removed',
        oldId: ep.id,
        show: ep.show,
        code: ep.code,
        removedTitle: ep.title,
        keptOldId: existing.id,
        keptTitle: existing.title,
        airDate: ep.airDate,
      });
      continue;
    }
    seen.set(key, ep);
    kept.push(ep);
  }

  return kept;
}

// Splices in any known-missing episode, immediately after the previous
// episode of the same show+season so global air order is preserved.
function addMissingEpisodes(episodes, notes) {
  for (const spec of MISSING_EPISODES) {
    const alreadyThere = episodes.some(
      (e) => e.show === spec.show && e.season === spec.season && e.episode === spec.episode
    );
    if (alreadyThere) continue;

    const row = {
      id: null, // assigned during renumbering
      show: spec.show,
      series: spec.series,
      code: `S${pad2(spec.season)}E${pad2(spec.episode)}`,
      season: spec.season,
      episode: spec.episode,
      title: spec.title,
      airDate: spec.airDate,
      sourceUrl: spec.sourceUrl || null,
    };

    let at = episodes.findIndex(
      (e) => e.show === spec.show && e.season === spec.season && e.episode === spec.episode - 1
    );
    // Fall back to the end of that season, then the end of that show.
    if (at === -1) {
      for (let i = 0; i < episodes.length; i++) {
        const e = episodes[i];
        if (e.show === spec.show && e.season === spec.season) at = i;
      }
    }
    if (at === -1) {
      for (let i = 0; i < episodes.length; i++) {
        if (episodes[i].show === spec.show) at = i;
      }
    }

    const insertAt = at === -1 ? episodes.length : at + 1;
    episodes.splice(insertAt, 0, row);

    notes.push({
      type: 'episode-added',
      show: row.show,
      code: row.code,
      title: row.title,
      airDate: row.airDate,
      afterOldId: at === -1 ? null : episodes[insertAt - 1].id,
    });
  }

  return episodes;
}

// Applies TITLE_OVERRIDES. Runs after dedup so it targets whichever copy of a
// duplicate pair survived.
function applyTitleOverrides(episodes, notes) {
  for (const spec of TITLE_OVERRIDES) {
    const ep = episodes.find(
      (e) => e.show === spec.show && e.season === spec.season && e.episode === spec.episode
    );
    if (!ep || ep.title === spec.to) continue;

    notes.push({
      type: 'title-overridden',
      oldId: ep.id,
      show: ep.show,
      code: ep.code,
      from: ep.title,
      to: spec.to,
      reason: spec.reason,
    });
    ep.title = spec.to;
  }
}

// Reassigns ids to 1..N so the "#" column stays gapless, and returns the
// old id -> new id mapping so saved progress can be migrated.
function renumber(episodes) {
  const idMap = new Map();
  episodes.forEach((ep, index) => {
    const newId = index + 1;
    if (ep.id !== null && ep.id !== undefined) idMap.set(ep.id, newId);
    ep.id = newId;
  });
  return idMap;
}

function buildShows(episodes) {
  const byShow = new Map();
  for (const ep of episodes) {
    if (!byShow.has(ep.show)) {
      byShow.set(ep.show, {
        slug: ep.show,
        name: ep.series,
        count: 0,
        firstId: ep.id,
        lastId: ep.id,
      });
    }
    const entry = byShow.get(ep.show);
    entry.count += 1;
    entry.firstId = Math.min(entry.firstId, ep.id);
    entry.lastId = Math.max(entry.lastId, ep.id);
  }
  return [...byShow.values()].sort((a, b) => a.firstId - b.firstId);
}

/**
 * Applies every data-quality fix to a freshly parsed episode list.
 * Returns the cleaned episodes, the rebuilt show index, an old->new id map,
 * and a note for every row that was changed, added or removed.
 */
function normalizeEpisodes(rawEpisodes) {
  const notes = [];
  let episodes = rawEpisodes.map((e) => ({ ...e }));

  repairCodes(episodes, notes);
  episodes = dropDuplicates(episodes, notes);
  episodes = addMissingEpisodes(episodes, notes);
  applyTitleOverrides(episodes, notes);
  const idMap = renumber(episodes);

  return { episodes, shows: buildShows(episodes), idMap, notes };
}

module.exports = { normalizeEpisodes, buildShows, MISSING_EPISODES, TITLE_OVERRIDES };
