// @ts-check
/**
 * Ride view: one vehicle's trip from where you board to the end of its
 * line, with every stop as a possible exit (earlier or later than
 * planned), and where the vehicle is right now.
 *
 * The trip comes from Router.trip (one request when the view opens). Exit
 * options at a stop come from a plan starting at that stop by id, departing
 * when the vehicle gets there (one request per tapped stop); the plans
 * include the walk to whatever boards next, and walking the rest of the
 * way is an option too.
 */

import { isTransit } from "./models.js";
import { boardsSameVehicle, distanceM } from "./transfers.js";

/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./models.js").Leg} Leg */
/** @typedef {import("./models.js").Trip} Trip */
/** @typedef {import("./models.js").TripStop} TripStop */
/** @typedef {import("./transfers.js").TransferOption} TransferOption */

const sec = (/** @type {Date} */ a, /** @type {Date} */ b) => (b.getTime() - a.getTime()) / 1000;
const point = (/** @type {[number, number]} */ [lat, lon]) => ({ lat, lon });

/**
 * The ride from the boarding stop to the end of the line.
 * @typedef {object} Ride
 * @property {TripStop[]} stops  boarding stop first
 * @property {number} exitIndex  the planned exit in `stops`
 * @property {[number, number][]} geometry  the trip's whole shape
 * @property {TripStop[]} before  the trip's stops before the boarding
 *   stop, to tell where a vehicle that hasn't come yet is
 */

/**
 * Cut the trip to the part you ride, matching the leg's stops by id
 * (platform first, then station). Null if the boarding stop isn't on the
 * trip (a different trip, or data without stop ids).
 * @param {Leg} leg @param {Trip} trip @returns {Ride | null}
 */
export function rideStops(leg, trip) {
  const find = (/** @type {string | null} */ stop, /** @type {string | null} */ station, from = 0) => {
    const i = trip.stops.findIndex((s, k) => k >= from && stop !== null && s.stopId === stop);
    if (i >= 0 || !station) return i;
    return trip.stops.findIndex((s, k) => k >= from && s.stationId === station);
  };
  const board = find(leg.fromStopId, leg.fromStationId);
  if (board < 0) return null;
  const exit = find(leg.toStopId, leg.toStationId, board + 1);
  const stops = trip.stops.slice(board);
  return {
    stops,
    exitIndex: exit < 0 ? stops.length - 1 : exit - board,
    geometry: trip.geometry,
    before: trip.stops.slice(0, board),
  };
}

/** Station (or stop) id to plan from or key own times by. @param {TripStop} s */
export const stopPlace = (s) => s.stationId ?? s.stopId;

// Distinct vehicles to keep per exit stop (plus walking the rest).
export const EXIT_OPTIONS = 5;
// Same vehicle if the line matches and departures are this close.
const SAME_DEPARTURE_S = 60;

/**
 * Options for getting off at `stop`: walking the rest of the way (if the
 * router offers it) and the first EXIT_OPTIONS vehicles, by departure.
 * The ride itself (staying on) isn't an option: that's the later stops.
 * It's recognised by trip id, or as the same route and direction leaving
 * this stop at the vehicle's time (transfers.js boardsSameVehicle).
 * At the planned exit, the planned continuation is marked "planned".
 *
 * @param {Itinerary[]} plans  from `stop`, departing at its arrival
 * @param {Itinerary} it  @param {number} rideIndex  the ride's leg in `it`
 * @param {TripStop} stop  @param {boolean} plannedExit
 * @returns {TransferOption[]}
 */
export function pickExitOptions(plans, it, rideIndex, stop, plannedExit) {
  const ride = it.legs[rideIndex];
  const next = it.legs.slice(rideIndex + 1).find(isTransit) ?? null;
  const alight = stopPlace(stop);
  const self = {
    tripId: ride.tripId ?? null,
    routeId: ride.routeId,
    directionId: ride.directionId,
    stopId: stop.stopId,
    stationId: stop.stationId,
    at: stop.departure,
  };
  /** @type {TransferOption[]} */
  const vehicles = [];
  /** @type {TransferOption | null} */
  let walk = null;
  const seen = new Set();
  for (const p of plans) {
    const leg = p.legs.find(isTransit);
    if (!leg) {
      // Fastest walk only; the router may repeat it.
      if (p.legs.length && (!walk || p.end < walk.arrival)) {
        walk = {
          plan: p, leg: p.legs[0], arrival: p.end, changeS: 0, deltaS: sec(it.end, p.end),
          kind: "alt", walkM: 0, boardKey: null, walkOnly: true,
        };
      }
      continue;
    }
    if (boardsSameVehicle(leg, self)) continue;
    const id = `${leg.line}@${Math.round(leg.start.getTime() / 1000)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const lead = p.legs.slice(0, p.legs.indexOf(leg));
    const board = leg.fromStationId ?? leg.fromStopId;
    const isPlanned =
      plannedExit && next !== null && leg.line === next.line &&
      Math.abs(sec(next.start, leg.start)) <= SAME_DEPARTURE_S;
    vehicles.push({
      plan: p,
      leg,
      arrival: p.end,
      changeS: sec(stop.arrival, leg.start),
      deltaS: sec(it.end, p.end),
      kind: isPlanned ? "planned" : "alt",
      walkM: lead.reduce((a, l) => a + l.distanceM, 0),
      boardKey: board ? `${alight}>${board}` : null,
      walkOnly: false,
    });
  }
  vehicles.sort((a, b) => a.leg.start.getTime() - b.leg.start.getTime());
  const kept = vehicles.slice(0, EXIT_OPTIONS);
  // The planned one stays even when more vehicles leave before it.
  const planned = vehicles.find((o) => o.kind === "planned");
  if (planned && !kept.includes(planned)) kept[kept.length - 1] = planned;
  return walk ? [walk, ...kept] : kept;
}

/** Index of the shape point nearest to `p`. @param {[number, number][]} g */
function nearestIndex(g, /** @type {{lat: number, lon: number}} */ p) {
  let best = 0;
  let bestD = Infinity;
  g.forEach((q, i) => {
    const d = distanceM(point(q), p);
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

/** @param {[number, number][]} g @returns {number} m */
const lengthM = (g) => g.slice(1).reduce((a, q, i) => a + distanceM(point(g[i]), point(q)), 0);

/**
 * The shape between two stops of a ride: cut from the trip's shape, or
 * straight lines through the stops when the router gave no shape.
 * @param {Ride} ride @param {number} from @param {number} to  indexes in ride.stops
 * @returns {[number, number][]}
 */
export function rideShape(ride, from, to) {
  const stops = ride.stops.slice(from, to + 1);
  const straight = /** @type {[number, number][]} */ (stops.map((s) => [s.lat, s.lon]));
  const g = ride.geometry;
  if (g.length < 2) return straight;
  const a = nearestIndex(g, stops[0]);
  const b = nearestIndex(g, stops[stops.length - 1]);
  // A loop line can put the end before the start; the stops are safer.
  return b > a ? g.slice(a, b + 1) : straight;
}

/**
 * The itinerary as it becomes when you get off at ride.stops[stopIndex]
 * and take option `plan` from there: the legs before the ride, the ride
 * cut (or extended) to that stop, then the plan.
 * @param {Itinerary} it @param {number} rideIndex @param {Ride} ride
 * @param {number} stopIndex @param {Itinerary} plan
 * @returns {Itinerary}
 */
export function applyExit(it, rideIndex, ride, stopIndex, plan) {
  const leg = it.legs[rideIndex];
  const stop = ride.stops[stopIndex];
  const geometry = rideShape(ride, 0, stopIndex);
  /** @type {Leg} */
  const cut = {
    ...leg,
    toName: stop.name,
    toStopId: stop.stopId,
    toStationId: stop.stationId,
    scheduledEnd: stop.scheduledArrival,
    end: stop.arrival,
    geometry,
    distanceM: lengthM(geometry),
  };
  const legs = [...it.legs.slice(0, rideIndex), cut, ...plan.legs];
  return {
    legs,
    start: it.start,
    end: plan.legs.length ? plan.end : stop.arrival,
    numTransfers: Math.max(0, legs.filter(isTransit).length - 1),
  };
}

/**
 * Where a vehicle is along the ride: on the segment from stops[after] to
 * stops[after + 1], `fraction` of the way. Straight segments between stops
 * are close enough to tell "between Valimo and Pitäjänmäki"; offM is how
 * far the vehicle is from that segment. after = -1: before the boarding
 * stop (not yet arrived); after = last index: at or past the end.
 * @param {TripStop[]} stops @param {{lat: number, lon: number}} pos
 * @returns {{after: number, fraction: number, offM: number}}
 */
export function vehicleProgress(stops, pos) {
  let best = { after: 0, fraction: 0, offM: Infinity };
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    // Project onto the segment in a local metric frame.
    const kx = 111_320 * Math.cos(a.lat * (Math.PI / 180));
    const [bx, by] = [(b.lon - a.lon) * kx, (b.lat - a.lat) * 110_574];
    const [px, py] = [(pos.lon - a.lon) * kx, (pos.lat - a.lat) * 110_574];
    const len2 = bx * bx + by * by;
    const f = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const offM = Math.hypot(px - f * bx, py - f * by);
    if (offM < best.offM) best = { after: i, fraction: f, offM };
  }
  // Clamped to the first segment's start: the vehicle may not be here yet.
  if (best.after === 0 && best.fraction === 0 && stops.length > 1) {
    const d0 = distanceM(stops[0], pos);
    if (d0 > 50) return { after: -1, fraction: 0, offM: best.offM };
  }
  // At the end of a segment = at the next stop (also settles the tie at a
  // stop between the segments before and after it).
  if (best.fraction === 1) return { after: best.after + 1, fraction: 0, offM: best.offM };
  return best;
}

/**
 * Where the ride's vehicle is, relative to your stops.
 * @typedef {object} RideProgress
 * @property {number} after  index in ride.stops of the stop it's at or
 *   just left; -1 while it hasn't reached your boarding stop
 * @property {number} fraction  of the way to the next stop
 * @property {{stopsAway: number, prev: string | null} | null} coming  set
 *   while after = -1: stops until yours (1 = yours is next), and the stop
 *   it's at or just left (null: not yet left its first stop)
 */

/**
 * vehicleProgress over the whole trip, so a vehicle still on its way to
 * your boarding stop reads as "coming", not as already past it (the stops
 * before yours would otherwise be missing and the nearest segment after
 * your stop would win).
 * @param {Ride} ride @param {{lat: number, lon: number}} pos
 * @returns {RideProgress}
 */
export function rideProgress(ride, pos) {
  const all = [...ride.before, ...ride.stops];
  const p = vehicleProgress(all, pos);
  const board = ride.before.length;
  if (p.after >= board) return { after: p.after - board, fraction: p.fraction, coming: null };
  return {
    after: -1,
    fraction: 0,
    coming: { stopsAway: board - p.after, prev: p.after >= 0 ? all[p.after].name : null },
  };
}
