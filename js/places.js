// @ts-check
/**
 * Place suggestions without per-keystroke API calls.
 *
 * Two local sources: an index of every HSL stop and station (one API
 * request, refreshed weekly) and the user's recent places. Matching runs on
 * the device, so typing a stop name costs nothing. Addresses are not in the
 * index; the UI falls back to Digitransit autocomplete for those.
 */

/** @typedef {import("./models.js").Place} Place */
/** @typedef {Pick<Storage, "getItem" | "setItem">} KeyValueStorage */

/**
 * One suggestion row. `detail` is the grey second line in the dropdown.
 * @typedef {object} PlaceOption
 * @property {string} name
 * @property {number} lat
 * @property {number} lon
 * @property {"stop" | "recent" | "address" | "favorite"} kind
 * @property {string} [detail]
 */

/**
 * A group of same-named stops close together ("Kamppi": metro, bus
 * terminal and street stops), shown as one suggestion.
 * @typedef {object} StopEntry
 * @property {string} name
 * @property {number} lat
 * @property {number} lon
 * @property {string[]} modes  best first (see MODE_RANK)
 * @property {string[]} codes  passenger-facing stop codes, e.g. "H2014"
 */

// Stops with the same name within this distance are one place.
const CLUSTER_M = 500;
const STOPS_KEY = "hoppu.stops.v1";
const RECENTS_KEY = "hoppu.recents.v1";
const FAVORITES_KEY = "hoppu.favorites.v1";
export const STOPS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_RECENTS = 15;

// Rail and metro first: "Pasila" should offer the station before a bus stop.
const MODE_RANK = /** @type {Record<string, number>} */ ({
  SUBWAY: 0,
  RAIL: 1,
  TRAM: 2,
  FERRY: 3,
  BUS: 4,
});
const MODE_LABEL = /** @type {Record<string, string>} */ ({
  SUBWAY: "Metro",
  RAIL: "Train",
  TRAM: "Tram",
  FERRY: "Ferry",
  BUS: "Bus",
});

/**
 * "Itäkeskus (M)" -> "itakeskus m". Diacritics are dropped so typing
 * without ä/ö still matches; punctuation becomes word breaks.
 * @param {string} s
 */
export function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Metres between two points; flat-earth approximation, fine below ~50 km. */
function distanceM(/** @type {number} */ lat1, /** @type {number} */ lon1,
                   /** @type {number} */ lat2, /** @type {number} */ lon2) {
  const dy = (lat2 - lat1) * 111_320;
  const dx = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * Group raw API stops/stations into one entry per name and neighbourhood.
 * Stations are just more members here: their names match the stops around
 * them often enough, and when they don't they stay separate entries.
 *
 * @param {any[]} stops  [{name, code, lat, lon, vehicleMode}]
 * @param {any[]} stations  [{name, lat, lon, vehicleMode}]
 * @returns {StopEntry[]}
 */
export function buildStopIndex(stops, stations) {
  /** @type {Map<string, {sumLat: number, sumLon: number, n: number, lat0: number, lon0: number, modes: Set<string>, codes: Set<string>, name: string}[]>} */
  const byName = new Map();
  for (const s of [...stations, ...stops]) {
    // TAXI and mode-less stops are not useful destinations.
    if (!(s.vehicleMode in MODE_RANK)) continue;
    const clusters = byName.get(s.name) ?? [];
    byName.set(s.name, clusters);
    // Compare against each cluster's first member, so a chain of stops
    // can't drag a cluster across town.
    let c = clusters.find((c) => distanceM(c.lat0, c.lon0, s.lat, s.lon) < CLUSTER_M);
    if (!c) {
      c = { name: s.name, sumLat: 0, sumLon: 0, n: 0, lat0: s.lat, lon0: s.lon,
            modes: new Set(), codes: new Set() };
      clusters.push(c);
    }
    c.sumLat += s.lat;
    c.sumLon += s.lon;
    c.n += 1;
    c.modes.add(s.vehicleMode);
    if (s.code) c.codes.add(s.code);
  }
  return [...byName.values()].flat().map((c) => ({
    name: c.name,
    // Centroid, rounded to ~1 m to keep the stored index small.
    lat: Math.round((c.sumLat / c.n) * 1e5) / 1e5,
    lon: Math.round((c.sumLon / c.n) * 1e5) / 1e5,
    modes: [...c.modes].sort((a, b) => MODE_RANK[a] - MODE_RANK[b]),
    codes: [...c.codes].sort(),
  }));
}

/** "Metro, bus · H0013, H1234 +3" @param {StopEntry} e */
function stopDetail(e) {
  const modes = e.modes.map((m, i) => (i ? MODE_LABEL[m].toLowerCase() : MODE_LABEL[m]));
  const codes = e.codes.slice(0, 3).join(", ") + (e.codes.length > 3 ? ` +${e.codes.length - 3}` : "");
  return codes ? `${modes.join(", ")} · ${codes}` : modes.join(", ");
}

/**
 * How well `name` matches the query tokens; lower is better, null = no
 * match. 0 exact, 1 name starts with the query, 2 every query token starts
 * some word of the name ("tulli tö" finds "Töölön tulli").
 *
 * @param {string} norm  normalized name
 * @param {string} q  normalized query
 * @returns {number | null}
 */
export function matchScore(norm, q) {
  if (!q) return null;
  if (norm === q) return 0;
  if (norm.startsWith(q)) return 1;
  const words = norm.split(" ");
  const ok = q.split(" ").every((t) => words.some((w) => w.startsWith(t)));
  return ok ? 2 : null;
}

/**
 * Matching over the stop index. Normalized names are computed once here,
 * not per keystroke.
 */
export class StopIndex {
  /** @param {StopEntry[]} entries */
  constructor(entries) {
    this.entries = entries.map((e) => ({
      e,
      norm: normalize(e.name),
      codes: e.codes.map((c) => c.toLowerCase()),
      rank: MODE_RANK[e.modes[0]] ?? 9,
    }));
  }

  get size() {
    return this.entries.length;
  }

  /**
   * Best matches for free text. A query containing a digit is also tried
   * as a stop code ("H2014" from the stop sign).
   * @param {string} text @param {number} [limit] @returns {PlaceOption[]}
   */
  search(text, limit = 6) {
    const q = normalize(text);
    if (!q) return [];
    const isCode = /\d/.test(q) && !q.includes(" ");
    /** @type {{x: (typeof this.entries)[number], score: number}[]} */
    const hits = [];
    for (const x of this.entries) {
      let score = matchScore(x.norm, q);
      if (isCode && x.codes.some((c) => c.startsWith(q))) score = Math.min(score ?? 1, 1);
      if (score !== null) hits.push({ x, score });
    }
    hits.sort(
      (a, b) =>
        a.score - b.score ||
        a.x.rank - b.x.rank ||
        a.x.e.name.length - b.x.e.name.length ||
        a.x.e.name.localeCompare(b.x.e.name, "fi"),
    );
    return hits.slice(0, limit).map(({ x }) => ({
      name: x.e.name,
      lat: x.e.lat,
      lon: x.e.lon,
      kind: "stop",
      detail: stopDetail(x.e),
    }));
  }

  /** The stop group named exactly `text` (best mode first), or null. @param {string} text */
  exact(text) {
    const hit = this.search(text, 1)[0];
    return hit && normalize(hit.name) === normalize(text) ? hit : null;
  }
}

/**
 * The stop index in storage, with its download time so it can be
 * refreshed weekly. Stored as arrays, not objects, to halve the size
 * (~4,000 entries).
 */
export class StopStore {
  /** @param {KeyValueStorage} storage */
  constructor(storage) {
    this.storage = storage;
  }

  /** @returns {{fetchedAt: number, entries: StopEntry[]} | null} */
  load() {
    try {
      const raw = JSON.parse(this.storage.getItem(STOPS_KEY) ?? "null");
      if (!raw || !Array.isArray(raw.entries)) return null;
      return {
        fetchedAt: raw.fetchedAt,
        entries: raw.entries.map((/** @type {any[]} */ [name, lat, lon, modes, codes]) => ({
          name,
          lat,
          lon,
          modes: modes ? modes.split(",") : [],
          codes: codes ? codes.split(",") : [],
        })),
      };
    } catch {
      return null;
    }
  }

  /** @param {StopEntry[]} entries @param {number} fetchedAt epoch ms */
  save(entries, fetchedAt) {
    const compact = entries.map((e) => [e.name, e.lat, e.lon, e.modes.join(","), e.codes.join(",")]);
    try {
      this.storage.setItem(STOPS_KEY, JSON.stringify({ fetchedAt, entries: compact }));
    } catch {
      // Quota: the index still works for this session from memory.
    }
  }

  /** @param {number} now epoch ms */
  isStale(now) {
    const s = this.load();
    return !s || now - s.fetchedAt > STOPS_MAX_AGE_MS;
  }
}

/** Places the user actually searched with, newest first. */
export class Recents {
  /** @param {KeyValueStorage} storage */
  constructor(storage) {
    this.storage = storage;
    /** @type {Place[]} */
    this.items = [];
    try {
      const raw = JSON.parse(storage.getItem(RECENTS_KEY) ?? "[]");
      if (Array.isArray(raw)) this.items = raw;
    } catch {
      // Corrupt or blocked storage: start empty.
    }
  }

  /** Move `place` to the front; same name = same place. @param {Place} place */
  add(place) {
    const { name, lat, lon } = place;
    this.items = [{ name, lat, lon }, ...this.items.filter((p) => p.name !== name)].slice(
      0,
      MAX_RECENTS,
    );
    try {
      this.storage.setItem(RECENTS_KEY, JSON.stringify(this.items));
    } catch {
      // Not persisted; fine for a convenience list.
    }
  }

  /**
   * Recents matching the text; with empty text the newest few.
   * @param {string} text @param {number} [limit] @returns {PlaceOption[]}
   */
  search(text, limit = 3) {
    const q = normalize(text);
    const hits = q
      ? this.items
          .map((p) => ({ p, score: matchScore(normalize(p.name), q) }))
          .filter((h) => h.score !== null)
          // Stable sort keeps recency order within a score.
          .sort((a, b) => /** @type {number} */ (a.score) - /** @type {number} */ (b.score))
          .map((h) => h.p)
      : this.items;
    return hits.slice(0, q ? limit : 5).map((p) => ({ ...p, kind: "recent" }));
  }
}

/**
 * A saved place under the user's own name ("Home").
 * @typedef {{label: string, place: Place}} Favorite
 */

/** Saved places in the user's order (chips, dropdown, settings). */
export class Favorites {
  /** @param {KeyValueStorage} storage */
  constructor(storage) {
    this.storage = storage;
    /** @type {Favorite[]} */
    this.items = [];
    try {
      const raw = JSON.parse(storage.getItem(FAVORITES_KEY) ?? "[]");
      if (Array.isArray(raw)) this.items = raw;
    } catch {
      // Corrupt or blocked storage: start empty.
    }
  }

  /**
   * Index of the favourite for this place: same name, or (for one picked
   * from a favourite row) the same label. -1 if none.
   * @param {{name: string, kind?: string}} p
   */
  indexOf(p) {
    return this.items.findIndex((f) =>
      p.kind === "favorite" ? f.label === p.name : f.place.name === p.name,
    );
  }

  /** @param {string} label @param {Place} place */
  add(label, place) {
    const { name, lat, lon } = place;
    this.items.push({ label: label.trim() || name, place: { name, lat, lon } });
    this.#save();
  }

  /** @param {number} i */
  remove(i) {
    this.items.splice(i, 1);
    this.#save();
  }

  /** @param {number} i @param {string} label */
  rename(i, label) {
    if (!label.trim()) return;
    this.items[i].label = label.trim();
    this.#save();
  }

  /** Move item i by delta (-1 up, +1 down), clamped. @param {number} i @param {number} delta */
  move(i, delta) {
    const j = Math.min(this.items.length - 1, Math.max(0, i + delta));
    if (i === j) return;
    const [item] = this.items.splice(i, 1);
    this.items.splice(j, 0, item);
    this.#save();
  }

  /** Favourite as a dropdown row: the label is what goes in the field. @param {Favorite} f @returns {PlaceOption} */
  static option(f) {
    return { name: f.label, lat: f.place.lat, lon: f.place.lon, kind: "favorite", detail: f.place.name };
  }

  /**
   * Favourites whose label or place name matches; all of them for empty text.
   * @param {string} text @returns {PlaceOption[]}
   */
  search(text) {
    const q = normalize(text);
    const hits = q
      ? this.items.filter(
          (f) => matchScore(normalize(f.label), q) !== null || matchScore(normalize(f.place.name), q) !== null,
        )
      : this.items;
    return hits.map(Favorites.option);
  }

  #save() {
    try {
      this.storage.setItem(FAVORITES_KEY, JSON.stringify(this.items));
    } catch {
      // Not persisted; works for this session.
    }
  }
}

/**
 * Local suggestions for the dropdown: saved places first, then recents,
 * then stops, each name shown once.
 * @param {string} text @param {Recents} recents @param {StopIndex | null} stops
 * @param {Favorites | null} [favorites]
 * @returns {PlaceOption[]}
 */
export function localSuggestions(text, recents, stops, favorites = null, limit = 8) {
  const favs = favorites?.search(text) ?? [];
  // A favourite hides its place from the other lists (by place name).
  const seen = new Set(favs.map((f) => f.detail));
  const recent = recents.search(text).filter((p) => !seen.has(p.name));
  for (const p of recent) seen.add(p.name);
  const fromStops = (stops?.search(text, limit) ?? []).filter((p) => !seen.has(p.name));
  return [...favs, ...recent, ...fromStops].slice(0, limit);
}
