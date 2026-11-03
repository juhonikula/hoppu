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
 * Options at a transfer come from a fresh plan that starts at the boarding
 * station itself (by stop id, so the router adds no walk of its own),
 * departing when the previous vehicle arrives; up to two departures before
 * the planned one, the planned one and two after are kept.
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
 * @property {string | null} boardLocationId  station (or stop) to plan the
 *   options from
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
 * @param {{walkMps: number, runMps: number, ownS: number | null}} opts
 *   ownS: the user's saved time for this transfer (replaces the walk
 *   estimate; running scales from it by the speed ratio)
 * @returns {Pace}
 */
export function transferPace(t, { walkMps, runMps, ownS }) {
  if (ownS !== null) return { walkS: ownS, runS: (ownS * walkMps) / runMps, own: true };
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
 */

// Same vehicle if the line matches and departures are this close; realtime
// estimates can shift by a few seconds between two requests.
const SAME_DEPARTURE_S = 60;

/** How many departures to list on each side of the planned one. */
export const OPTIONS_BEFORE = 2;
export const OPTIONS_AFTER = 2;

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
 * and the first OPTIONS_AFTER after it.
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
 * @returns {TransferOption[]}
 */
export function pickOptions(plans, t, plannedArrival, from = {}) {
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
    });
  }
  all.sort((a, b) => a.leg.start.getTime() - b.leg.start.getTime());
  const earlier = all.filter((o) => o.kind === "earlier").slice(-OPTIONS_BEFORE);
  const planned = all.filter((o) => o.kind === "planned").slice(0, 1);
  const later = all.filter((o) => o.kind === "later").slice(0, OPTIONS_AFTER);
  return [...earlier, ...planned, ...later];
}

/**
 * Pace for one option: its own walk distance, and the own time saved for
 * the station pair it changes between (if any).
 * @param {TransferOption} o
 * @param {{walkMps: number, runMps: number, ownS: number | null}} opts  ownS
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
 * @property {Date} departAt  also the options' "arrival" (changes count from it)
 * @property {number} keepLegs  legs of the itinerary kept before the option's plan
 * @property {number} extraWalkM  walk to the vehicles that isn't in the plans
 * @property {string | null} alightId  station planned from, for own-time keys
 * @property {VehicleAt | null} skip  the vehicle just left
 */

/**
 * Options are planned from where the previous vehicle drops you (first
 * boarding: the search origin), at the plan's time there, never from GPS:
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
  const base = { keepLegs: prev + 1, extraWalkM: 0, departAt: t.arrival };
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

const TIMES_KEY = "hoppu.transferTimes.v1";

/**
 * The user's own change times for specific transfers, e.g. "Helsinki ->
 * Rautatientori: 2 min", keyed by Transfer.key.
 */
export class TransferTimes {
  /** @param {KeyValueStorage} storage */
  constructor(storage) {
    this.storage = storage;
    /** @type {Record<string, {label: string, seconds: number}>} */
    this.items = {};
    try {
      const raw = JSON.parse(storage.getItem(TIMES_KEY) ?? "{}");
      if (raw && typeof raw === "object") this.items = raw;
    } catch {
      // Corrupt or blocked storage: start empty.
    }
  }

  /** @param {string | null} key @returns {number | null} seconds */
  get(key) {
    return key && key in this.items ? this.items[key].seconds : null;
  }

  /** @param {string} key @param {number} seconds @param {string} label */
  set(key, seconds, label) {
    this.items[key] = { label, seconds: Math.max(0, seconds) };
    this.#save();
  }

  /** @param {string} key */
  remove(key) {
    delete this.items[key];
    this.#save();
  }

  /** @returns {{key: string, label: string, seconds: number}[]} by label */
  list() {
    return Object.entries(this.items)
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.label.localeCompare(b.label, "fi"));
  }

  #save() {
    try {
      this.storage.setItem(TIMES_KEY, JSON.stringify(this.items));
    } catch {
      // Not persisted; works for this session.
    }
  }
}
