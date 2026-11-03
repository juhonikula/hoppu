// @ts-check
/**
 * Derived numbers the UI shows: transfer margins, delays, comparisons.
 * Pure functions over the models; no formatting beyond small helpers.
 */

import { isTransit } from "./models.js";

/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./models.js").Leg} Leg */

/** @param {Date} a @param {Date} b @returns {number} b - a in seconds */
const secondsBetween = (a, b) => (b.getTime() - a.getTime()) / 1000;

/**
 * Transfer margin per leg: seconds between arriving at the stop (end of the
 * previous leg, usually a transfer walk) and the vehicle leaving. null where
 * the leg isn't a boarding at a real transfer: before the first boarding,
 * OTP time-shifts the walk to arrive exactly on departure, so a margin there
 * would always read 0 and mean nothing.
 *
 * @param {Itinerary} it @returns {(number | null)[]}
 */
export function legMargins(it) {
  let seenTransit = false;
  return it.legs.map((leg, i) => {
    const margin =
      isTransit(leg) && seenTransit ? secondsBetween(it.legs[i - 1].end, leg.start) : null;
    seenTransit ||= isTransit(leg);
    return margin;
  });
}

/** Smallest margin at any transfer, null for direct trips. @param {Itinerary} it */
export function tightestMargin(it) {
  const margins = legMargins(it).filter((m) => m !== null);
  return margins.length ? Math.min(...margins) : null;
}

/** Departure delay in seconds; null without realtime data. @param {Leg} leg */
export const departureDelay = (leg) =>
  leg.realtime ? secondsBetween(leg.scheduledStart, leg.start) : null;

/** @param {Itinerary[]} its @returns {Date | null} */
export function earliestArrival(its) {
  if (!its.length) return null;
  return new Date(Math.min(...its.map((it) => it.end.getTime())));
}

/**
 * Earliest arrivals of hoppu vs a baseline (the HSL app settings).
 * savedS is negative when hoppu is slower.
 *
 * @param {Itinerary[]} hoppu @param {Itinerary[]} baseline
 * @returns {{hoppu: Date, baseline: Date, savedS: number} | null}
 */
export function compareArrivals(hoppu, baseline) {
  const h = earliestArrival(hoppu);
  const b = earliestArrival(baseline);
  if (!h || !b) return null;
  return { hoppu: h, baseline: b, savedS: secondsBetween(h, b) };
}

/** How long a leg takes, in seconds (expected times). @param {Leg} leg */
export const legDurationS = (leg) => secondsBetween(leg.start, leg.end);

/**
 * Where each leg sits in the trip, as fractions of the whole trip time, for
 * the proportional colour bar. Time between legs (waiting at a stop) is not
 * covered by any span, so it shows as empty track.
 *
 * @param {Itinerary} it
 * @returns {{leg: Leg, left: number, width: number}[]}  fractions in [0, 1]
 */
export function legSpans(it) {
  const t0 = it.start.getTime();
  // Guard against a zero-length trip (origin = destination).
  const total = Math.max(it.end.getTime() - t0, 1);
  const clamp = (/** @type {number} */ x) => Math.min(1, Math.max(0, x));
  return it.legs.map((leg) => {
    const left = clamp((leg.start.getTime() - t0) / total);
    const right = clamp((leg.end.getTime() - t0) / total);
    return { leg, left, width: right - left };
  });
}
