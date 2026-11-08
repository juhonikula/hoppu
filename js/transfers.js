// @ts-check
/**
 * Transfers: how much time each change gives you, and whether you can make
 * it walking, only running, or not at all.
 *
 * A transfer's time is simply the previous vehicle's arrival to the next
 * departure. Whether it's enough is judged with the user's own speeds over
 * the transfer's walking distance (the planner's walk times include
 * station penalties and run long, e.g. 455 m in 4:27):
 *   transfer >= walk time        reachable walking; graded by the time left
 *                                 (red < 1 min, amber < 2 min, else fine)
 *   run time <= transfer < walk  only by running (purple)
 *   transfer < run time          not reachable (struck through; still
 *                                 listed among options: delays happen)
 * A saved own time for the transfer replaces the walk estimate.
 *
 * Options at a transfer come from fresh plans that start where the
 * previous vehicle drops you (by stop id), from a while before it arrives,
 * so departures too close to make (even ones leaving before you get there)
 * are in them too: two departures before the planned one, the planned one
 * and two after (nextOptionsRequest looks further back until there are
 * two before). The original route's departure is marked and always kept.
 */

import { isTransit } from "./models.js";

/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./models.js").Leg} Leg */
/** @typedef {import("./models.js").Place} Place */
/** @typedef {Pick<Storage, "getItem" | "setItem">} KeyValueStorage */

/**
 * A change between two vehicles within one itinerary.
 * @typedef {object} Transfer
 * @property {number} legIndex  index of the leg boarded at this transfer
 * @property {Date} arrival  when the previous vehicle arrives
 * @property {Date} plannedDeparture  the planned next vehicle
 * @property {string | null} plannedLine
 * @property {number} walkS  the router's walk between the vehicles; 0 for
 *   a same-stop change
 * @property {number} distanceM  walking distance between the vehicles
 * @property {string} fromName  stop you alight at
 * @property {string} toName  stop you board at
 * @property {string | null} key  "alighting station>boarding station", for
 *   per-transfer times; null when the router gave no stop ids
 * @property {string | null} boardLocationId  station (or stop) you board at
 * @property {string | null} alightLocationId  station (or stop) the
 *   previous vehicle drops you at; null for the first boarding
 * @property {boolean} first  the first boarding: "arrival" is when you set
 *   off (see findTransfers' setOff) and the walk is from your starting
 *   point (only with includeFirst)
 */

const sec = (/** @type {Date} */ a, /** @type {Date} */ b) => (b.getTime() - a.getTime()) / 1000;

/**
 * Every vehicle change in an itinerary, in order. With includeFirst, the
 * first boarding counts too, as a "transfer" from setting off: same walk
 * and options logic, e.g. for when you left late.
 *
 * You set off at `setOff` (the search's leave-at time) when that's before
 * the plan's start: the plan starts exactly when you must leave, so counted
 * from there the first boarding would never have time to spare. A plan
 * that starts earlier (an earlier results page) counts from its own start.
 * @param {Itinerary} it @param {{includeFirst?: boolean, setOff?: Date | null}} [opts]
 * @returns {Transfer[]}
 */
export function findTransfers(it, { includeFirst = false, setOff = null } = {}) {
  /** @type {Transfer[]} */
  const out = [];
  let prev = -1; // index of the last transit leg seen
  it.legs.forEach((leg, i) => {
    if (!isTransit(leg)) return;
    const board = leg.fromStationId ?? leg.fromStopId;
    if (prev < 0 && includeFirst) {
      const walks = it.legs.slice(0, i);
      out.push({
        legIndex: i,
        arrival: setOff && setOff < it.start ? setOff : it.start,
        plannedDeparture: leg.start,
        plannedLine: leg.line,
        walkS: walks.reduce((a, l) => a + sec(l.start, l.end), 0),
        distanceM: walks.reduce((a, l) => a + l.distanceM, 0),
        fromName: it.legs[0].fromName,
        toName: leg.fromName,
        key: null, // own times are per station pair; a start point isn't one
        boardLocationId: board,
        alightLocationId: null,
        first: true,
      });
    }
    if (prev >= 0) {
      const before = it.legs[prev];
      // Walk legs between the two vehicles (usually zero or one).
      const walks = it.legs.slice(prev + 1, i);
      const walkS = walks.reduce((a, l) => a + sec(l.start, l.end), 0);
      const distanceM = walks.reduce((a, l) => a + l.distanceM, 0);
      const alight = before.toStationId ?? before.toStopId;
      out.push({
        legIndex: i,
        arrival: before.end,
        plannedDeparture: leg.start,
        plannedLine: leg.line,
        walkS,
        distanceM,
        fromName: before.toName,
        toName: leg.fromName,
        key: alight && board ? `${alight}>${board}` : null,
        boardLocationId: board,
        alightLocationId: alight,
        first: false,
      });
    }
    prev = i;
  });
  return out;
}

/** Warn about the walk from this distance on. */
export const LONG_WALK_M = 400;

/**
 * Walk and run times for a transfer at the user's speeds.
 * @typedef {{walkS: number, runS: number, own: boolean}} Pace
 */

/**
 * @param {Transfer} t
 * @param {{walkMps: number, runMps: number, own?: OwnTime | null}} opts
 *   own: the user's saved times for this station pair (TransferTimes.get).
 *   They replace the estimate; a mode without samples scales from the
 *   other by the speed ratio (walked 2:00 at 8 km/h -> ran 1:20 at 12).
 * @returns {Pace}
 */
export function transferPace(t, { walkMps, runMps, own = null }) {
  if (own && (own.walkS !== null || own.runS !== null)) {
    const walkS = own.walkS ?? (/** @type {number} */ (own.runS) * runMps) / walkMps;
    const runS = own.runS ?? (walkS * walkMps) / runMps;
    return { walkS, runS, own: true };
  }
  return { walkS: t.distanceM / walkMps, runS: t.distanceM / runMps, own: false };
}

/**
 * How a transfer of `transferS` seconds fits the pace.
 * @param {number} transferS @param {Pace} pace
 * @returns {{kind: "ok" | "snug" | "tight" | "run" | "impossible", spareS: number}}
 *   spareS: time left after walking (negative when running is needed)
 */
export function classifyTransfer(transferS, pace) {
  const spareS = transferS - pace.walkS;
  if (spareS >= 0) {
    return { kind: spareS < 60 ? "tight" : spareS < 120 ? "snug" : "ok", spareS };
  }
  return { kind: transferS >= pace.runS ? "run" : "impossible", spareS };
}

/**
 * One way to continue from a transfer.
 * @typedef {object} TransferOption
 * @property {Itinerary} plan  the whole continuation from the station
 * @property {Leg} leg  the first vehicle of the continuation; for a
 *   walk-only option, the walk
 * @property {Date} arrival  at the destination
 * @property {number} changeS  time from the previous arrival to this departure
 * @property {number} deltaS  arrival vs the planned itinerary's; negative = earlier
 * @property {"earlier" | "planned" | "later" | "alt"} kind  "alt": a ride
 *   view exit option that isn't the planned continuation
 * @property {number} walkM  walking distance to this vehicle: the plan's
 *   own walk plus any walk outside it (the transfer walk when planned from
 *   the boarding station)
 * @property {string | null} boardKey  own-time key ("alighting>boarding"
 *   station) for this option's change; it may board somewhere else than
 *   the planned transfer
 * @property {boolean} walkOnly  walk the rest of the way, no vehicle
 * @property {boolean} [original]  the original route's departure here
 *   (pickOptions' `original`); "planned" is the shown version's
 */

// Same vehicle if the line matches and departures are this close; realtime
// estimates can shift by a few seconds between two requests.
const SAME_DEPARTURE_S = 60;

/** How many departures to list on each side of the planned one. */
export const OPTIONS_BEFORE = 2;
export const OPTIONS_AFTER = 2;

/**
 * Options are planned from OPTIONS_LOOKBACK_S before you arrive, then
 * another step back at a time (one request each) while fewer than
 * OPTIONS_BEFORE departures before the planned one turn up, up to
 * OPTIONS_LOOKBACK_MAX_S. Planned from the arrival itself, the router only
 * returns departures you can walk to at its own speed, so the ones too
 * close to make never showed up (phone test 2026-11-08); from earlier they
 * do, and are judged by pace (struck through when even running is too
 * slow).
 */
export const OPTIONS_LOOKBACK_S = 10 * 60;
export const OPTIONS_LOOKBACK_MAX_S = 30 * 60;

/** Walking before a plan's first vehicle, m. @param {Itinerary} p @param {Leg} first */
const leadingWalkM = (p, first) =>
  p.legs.slice(0, p.legs.indexOf(first)).reduce((a, l) => a + l.distanceM, 0);

/** Station (or stop) a leg boards at, for own-time keys. @param {Leg} leg */
const boardId = (leg) => leg.fromStationId ?? leg.fromStopId;

/**
 * The vehicle you're on (ride view) or just left (transfer options), at
 * the stop the options are planned from. Boarding it there again isn't an
 * option.
 * @typedef {object} VehicleAt
 * @property {string | null} tripId
 * @property {string | null} routeId
 * @property {number | null} directionId
 * @property {string | null} stopId  the stop you get off at
 * @property {string | null} stationId  its station, if any
 * @property {Date} at  the vehicle's time at that stop
 */

/**
 * Whether `leg` boards vehicle `v` at its stop: the same trip id, or the
 * same route and direction leaving that stop (or station) within
 * SAME_DEPARTURE_S of the vehicle's own time there. The second catches the
 * same vehicle under another trip id (seen on the phone 2026-11-03: an
 * exit option re-boarding the bus you're on); a later vehicle of the same
 * line stays an option.
 * @param {Leg} leg @param {VehicleAt} v
 */
export function boardsSameVehicle(leg, v) {
  if (v.tripId && leg.tripId === v.tripId) return true;
  const sameStop =
    (v.stopId !== null && leg.fromStopId === v.stopId) ||
    (v.stationId !== null && leg.fromStationId === v.stationId);
  return (
    v.routeId !== null &&
    leg.routeId === v.routeId &&
    leg.directionId === v.directionId &&
    sameStop &&
    Math.abs(sec(v.at, leg.start)) <= SAME_DEPARTURE_S
  );
}

/**
 * Turn the plans from a transfer's origin into a short option list: the
 * last OPTIONS_BEFORE departures before the planned one, the planned one,
 * and the first OPTIONS_AFTER after it. The original route's departure
 * here (`original`, see originalBoarding) is marked and kept even outside
 * that window; it's the planned one until you follow another option.
 *
 * `from` says where the plans start (see optionsOrigin): by default the
 * boarding station, with the transfer walk outside the plans. Planned from
 * the alighting stop or GPS instead, the plans include the walk
 * (extraWalkM 0), each option keys its own time by where it boards, and
 * the vehicle just left (`skip`, boardsSameVehicle) isn't an option.
 *
 * @param {Itinerary[]} plans
 * @param {Transfer} t  @param {Date} plannedArrival  the original itinerary's end
 * @param {{extraWalkM?: number, alightId?: string | null, skip?: VehicleAt | null}} [from]
 * @param {Leg | null} [original]
 * @returns {TransferOption[]}
 */
export function pickOptions(plans, t, plannedArrival, from = {}, original = null) {
  const { extraWalkM = t.distanceM, alightId = null, skip = null } = from;
  /** @type {TransferOption[]} */
  const all = [];
  const seen = new Set();
  for (const p of plans) {
    const leg = p.legs.find(isTransit);
    if (!leg) continue; // a walk-only plan isn't a transfer option
    if (skip && boardsSameVehicle(leg, skip)) continue;
    const id = `${leg.line}@${Math.round(leg.start.getTime() / 1000)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const board = boardId(leg);
    const isPlanned =
      leg.line === t.plannedLine &&
      Math.abs(sec(t.plannedDeparture, leg.start)) <= SAME_DEPARTURE_S;
    all.push({
      plan: p,
      leg,
      arrival: p.end,
      changeS: sec(t.arrival, leg.start),
      deltaS: sec(plannedArrival, p.end),
      kind: isPlanned ? "planned" : leg.start < t.plannedDeparture ? "earlier" : "later",
      walkM: extraWalkM + leadingWalkM(p, leg),
      boardKey: alightId ? (board ? `${alightId}>${board}` : null) : t.key,
      walkOnly: false,
      original: original !== null && sameDeparture(leg, original),
    });
  }
  all.sort((a, b) => a.leg.start.getTime() - b.leg.start.getTime());
  const earlier = all.filter((o) => o.kind === "earlier").slice(-OPTIONS_BEFORE);
  const planned = all.filter((o) => o.kind === "planned").slice(0, 1);
  const later = all.filter((o) => o.kind === "later").slice(0, OPTIONS_AFTER);
  const kept = [...earlier, ...planned, ...later];
  const orig = all.find((o) => o.original);
  if (orig && !kept.includes(orig)) {
    kept.push(orig);
    kept.sort((a, b) => a.leg.start.getTime() - b.leg.start.getTime());
  }
  return kept;
}

/** The same departure: same trip, or same line within SAME_DEPARTURE_S. @param {Leg} a @param {Leg} b */
const sameDeparture = (a, b) =>
  (a.tripId != null && a.tripId === b.tripId) ||
  (a.line === b.line && Math.abs(sec(a.start, b.start)) <= SAME_DEPARTURE_S);

/**
 * The original route's vehicle at transfer `t` of a later version: its
 * first boarding for the first boarding, else its boarding after the same
 * alighting station (options are planned from there), else at the same
 * boarding station. Null when the original never comes by here.
 * @param {Itinerary} original  the route's first version
 * @param {Transfer} t  a transfer of the shown version
 * @returns {Leg | null}
 */
export function originalBoarding(original, t) {
  const ts = findTransfers(original, { includeFirst: true });
  const o = t.first
    ? ts.find((x) => x.first)
    : (ts.find((x) => t.alightLocationId !== null && x.alightLocationId === t.alightLocationId) ??
      ts.find((x) => t.boardLocationId !== null && x.boardLocationId === t.boardLocationId));
  return o ? original.legs[o.legIndex] : null;
}

/**
 * The next options request for transfer `t`, or null when the options are
 * complete: one step further back (OPTIONS_LOOKBACK_S each, up to
 * OPTIONS_LOOKBACK_MAX_S) while fewer than OPTIONS_BEFORE departures
 * before the planned one came up; then, if fewer than OPTIONS_AFTER after
 * it did (a busy stop fills the reply with earlier ones), one request
 * from just after the latest departure found. Merge the replies and pick
 * again (pickOptions) after each.
 * @param {Transfer} t @param {TransferOption[]} options  picked so far
 * @param {{backS: number, later: boolean}} done  the furthest look-back
 *   asked so far (0 = none yet), and whether the "later" request was made
 * @returns {{departAt: Date, backS: number, later: boolean} | null}
 */
export function nextOptionsRequest(t, options, done) {
  const count = (/** @type {string} */ kind) => options.filter((o) => o.kind === kind).length;
  if (done.backS === 0 || (count("earlier") < OPTIONS_BEFORE && done.backS < OPTIONS_LOOKBACK_MAX_S)) {
    const backS = done.backS + OPTIONS_LOOKBACK_S;
    return { departAt: new Date(t.arrival.getTime() - backS * 1000), backS, later: done.later };
  }
  const last = options.at(-1);
  if (count("later") < OPTIONS_AFTER && !done.later && last) {
    return { departAt: new Date(last.plan.start.getTime() + 1000), backS: done.backS, later: true };
  }
  return null;
}

/**
 * Pace for one option: its own walk distance, and the own time saved for
 * the station pair it changes between (if any).
 * @param {TransferOption} o
 * @param {{walkMps: number, runMps: number, own?: OwnTime | null}} opts  own
 *   looked up by o.boardKey
 * @returns {Pace}
 */
export const optionPace = (o, opts) =>
  transferPace(/** @type {Transfer} */ ({ distanceM: o.walkM }), opts);

/** Metres between two points; flat-earth, fine at city scale. */
export function distanceM(/** @type {{lat: number, lon: number}} */ a, /** @type {{lat: number, lon: number}} */ b) {
  const kx = 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot((a.lat - b.lat) * 110_574, (a.lon - b.lon) * kx);
}

/**
 * Where and when to plan a transfer's options from.
 * @typedef {object} OptionsOrigin
 * @property {Place} origin
 * @property {number} keepLegs  legs of the itinerary kept before the option's plan
 * @property {number} extraWalkM  walk to the vehicles that isn't in the plans
 * @property {string | null} alightId  station planned from, for own-time keys
 * @property {VehicleAt | null} skip  the vehicle just left
 */

/**
 * Options are planned from where the previous vehicle drops you (first
 * boarding: the search origin), counted from the plan's time there
 * (t.arrival; how far before it: nextOptionsRequest), never from GPS:
 * the router includes the walk, so connections from other stops nearby
 * show up, and the plan's time shows what you could catch if you're
 * quicker than planned. (For a fresh start from where you are, search
 * again from "My location".)
 *
 * @param {Itinerary} it @param {Transfer} t
 * @param {Place} searchOrigin  where the search started
 * @returns {OptionsOrigin}
 */
export function optionsOrigin(it, t, searchOrigin) {
  let prev = -1; // last vehicle before this boarding
  it.legs.forEach((l, i) => {
    if (i < t.legIndex && isTransit(l)) prev = i;
  });
  const rode = it.legs[prev];
  const base = { keepLegs: prev + 1, extraWalkM: 0 };
  if (!rode) return { ...base, origin: searchOrigin, alightId: null, skip: null };
  const end = rode.geometry.at(-1);
  const alightId = rode.toStationId ?? rode.toStopId;
  return {
    ...base,
    origin: {
      name: rode.toName,
      lat: end?.[0] ?? 0,
      lon: end?.[1] ?? 0,
      ...(alightId ? { stopId: alightId } : {}),
    },
    alightId,
    skip: {
      tripId: rode.tripId ?? null,
      routeId: rode.routeId,
      directionId: rode.directionId,
      stopId: rode.toStopId,
      stationId: rode.toStationId,
      at: rode.end,
    },
  };
}

/**
 * The itinerary as it becomes when the user takes an option at transfer
 * `t`: the original legs up to the boarding (the transfer walk keeps the
 * router's times), then the option's plan from the station. Options
 * planned from elsewhere (optionsOrigin) keep fewer legs: `keepLegs`.
 *
 * The walk is deliberately not shortened: the boarding then shows a
 * negative transfer margin (e.g. -1:27 = "be 1:27 faster than the walk"),
 * which is the bet, and the result's transfer boxes still start from the
 * router's walk time instead of applying the margin twice.
 *
 * @param {Itinerary} it @param {Transfer} t @param {Itinerary} plan
 * @param {number} [keepLegs]
 * @returns {Itinerary}
 */
export function applyOption(it, t, plan, keepLegs = t.legIndex) {
  const legs = [...it.legs.slice(0, keepLegs), ...plan.legs];
  return {
    legs,
    start: keepLegs > 0 ? it.start : plan.start,
    end: plan.end,
    numTransfers: Math.max(0, legs.filter(isTransit).length - 1),
  };
}

/**
 * The itinerary as when you set off at `at` (Hoppu!: now) instead of the
 * planner's start. The planner starts a route at the last moment that
 * still catches the first vehicle; here the walk before it moves earlier,
 * so any slack becomes waiting at the stop. The vehicles and the arrival
 * stay; a walk-only route just starts (and ends) earlier. Unchanged when
 * the plan starts at or before `at`.
 * @param {Itinerary} it @param {Date} at @returns {Itinerary}
 */
export function leaveAt(it, at) {
  const shiftMs = it.start.getTime() - at.getTime();
  if (shiftMs <= 0) return it;
  const firstVehicle = it.legs.findIndex(isTransit);
  const walkOnly = firstVehicle < 0;
  const moved = walkOnly ? it.legs.length : firstVehicle;
  const move = (/** @type {Date} */ d) => new Date(d.getTime() - shiftMs);
  const legs = it.legs.map((l, i) =>
    i < moved
      ? { ...l, start: move(l.start), end: move(l.end), scheduledStart: move(l.scheduledStart), scheduledEnd: move(l.scheduledEnd) }
      : l,
  );
  return { ...it, legs, start: at, end: walkOnly ? move(it.end) : it.end };
}

const TIMES_KEY = "hoppu.transferTimes.v2";
// v1: one number per station pair, {key: {label, seconds}}; walk times.
const TIMES_V1_KEY = "hoppu.transferTimes.v1";

/**
 * One timed change: how long it took and whether you walked or ran it.
 * @typedef {object} TimeSample
 * @property {number} s  seconds, >= 0
 * @property {"walk" | "run"} mode
 * @property {number | null} m  the transfer's walking distance then (for
 *   the average pace); null for samples migrated from v1
 * @property {number | null} at  epoch ms when saved; null if migrated
 */

/**
 * A station pair's own times: the average of its walk samples and of its
 * run samples (null when it has none of that mode).
 * @typedef {{walkS: number | null, runS: number | null}} OwnTime
 */

/** @param {TimeSample[]} list @param {"walk" | "run"} mode */
const meanS = (list, mode) => {
  const xs = list.filter((x) => x.mode === mode);
  return xs.length ? xs.reduce((a, x) => a + x.s, 0) / xs.length : null;
};

/**
 * The user's own change times per station pair, e.g. "Helsinki ->
 * Rautatientori", keyed by Transfer.key. Every save is kept as a sample
 * (walked or ran), so repeated transfers refine the average, and all
 * samples with a distance give the user's average walking and running
 * pace (shown in settings only, never used for planning).
 */
export class TransferTimes {
  /** @param {KeyValueStorage} storage */
  constructor(storage) {
    this.storage = storage;
    /** @type {Record<string, {label: string, samples: TimeSample[]}>} */
    this.items = {};
    try {
      const raw = storage.getItem(TIMES_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        // Keep only well-formed pairs: a broken entry mustn't break the rest.
        for (const [key, v] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
          const samples = Array.isArray(v?.samples)
            ? v.samples.filter((/** @type {any} */ x) => typeof x?.s === "number" && (x.mode === "walk" || x.mode === "run"))
            : [];
          if (samples.length) this.items[key] = { label: String(v.label ?? key), samples };
        }
      } else {
        // v1 entries become one walk sample each (no distance: they keep
        // working as own times but don't count towards the pace).
        const v1 = JSON.parse(storage.getItem(TIMES_V1_KEY) ?? "{}");
        for (const [key, v] of Object.entries(v1 ?? {})) {
          if (typeof v?.seconds !== "number") continue;
          this.items[key] = { label: String(v.label ?? key), samples: [{ s: v.seconds, mode: "walk", m: null, at: null }] };
        }
      }
    } catch {
      // Corrupt or blocked storage: start empty.
    }
  }

  /**
   * Average own time per mode for a station pair; null without samples.
   * @param {string | null} key @returns {OwnTime | null}
   */
  get(key) {
    const item = key ? this.items[key] : undefined;
    if (!item?.samples.length) return null;
    return { walkS: meanS(item.samples, "walk"), runS: meanS(item.samples, "run") };
  }

  /** How many samples a station pair has. @param {string | null} key */
  count(key) {
    return key ? (this.items[key]?.samples.length ?? 0) : 0;
  }

  /**
   * Keep one more sample for a station pair.
   * @param {string} key @param {string} label
   * @param {{seconds: number, mode: "walk" | "run", distanceM: number | null, at?: number}} sample
   */
  add(key, label, { seconds, mode, distanceM, at = Date.now() }) {
    const item = (this.items[key] ??= { label, samples: [] });
    item.label = label;
    item.samples.push({ s: Math.max(0, seconds), mode, m: distanceM, at });
    this.#save();
  }

  /** Drop one sample (by its index in list()); the pair goes with its last. @param {string} key @param {number} index */
  removeSample(key, index) {
    const item = this.items[key];
    if (!item) return;
    item.samples.splice(index, 1);
    if (!item.samples.length) delete this.items[key];
    this.#save();
  }

  /** Drop a station pair with all its samples. @param {string} key */
  remove(key) {
    delete this.items[key];
    this.#save();
  }

  /** @returns {{key: string, label: string, samples: TimeSample[], own: OwnTime}[]} by label */
  list() {
    return Object.entries(this.items)
      .map(([key, v]) => ({ key, label: v.label, samples: v.samples, own: /** @type {OwnTime} */ (this.get(key)) }))
      .sort((a, b) => a.label.localeCompare(b.label, "fi"));
  }

  /**
   * Average pace over every sample with a distance, per mode: all metres
   * over all seconds, so long transfers weigh more than short ones.
   * @returns {{walk: {kmh: number, n: number} | null, run: {kmh: number, n: number} | null}}
   */
  averagePace() {
    const all = Object.values(this.items).flatMap((v) => v.samples).filter((x) => x.m && x.m > 0 && x.s > 0);
    /** @param {"walk" | "run"} mode */
    const avg = (mode) => {
      const xs = all.filter((x) => x.mode === mode);
      if (!xs.length) return null;
      const m = xs.reduce((a, x) => a + /** @type {number} */ (x.m), 0);
      const s = xs.reduce((a, x) => a + x.s, 0);
      return { kmh: (m / s) * 3.6, n: xs.length };
    };
    return { walk: avg("walk"), run: avg("run") };
  }

  #save() {
    try {
      this.storage.setItem(TIMES_KEY, JSON.stringify(this.items));
    } catch {
      // Not persisted; works for this session.
    }
  }
}
