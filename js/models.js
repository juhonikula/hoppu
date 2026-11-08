// @ts-check
/**
 * Router-independent data types (JSDoc only, no runtime code).
 *
 * Nothing here knows about Digitransit, so a future custom router can
 * produce the same objects and the UI won't notice. Times are Date objects
 * (absolute instants); durations and costs are plain seconds.
 */

/**
 * @typedef {object} Place
 * @property {string} name
 * @property {number} lat
 * @property {number} lon
 * @property {string} [stopId]  start/end at this stop or station (router
 *   id, e.g. "HSL:1000103") instead of the coordinate; no walk is added to
 *   reach it
 */

/**
 * Optional fields left undefined or null mean "use the router's default".
 * 0 is a real value (zero slack, free boardings), never "unset".
 *
 * @typedef {object} RouteQuery
 * @property {Place} origin
 * @property {Place} destination
 * @property {Date} departAt  leave at this time, or arrive by it (arriveBy)
 * @property {boolean} [arriveBy]  departAt is the latest arrival
 * @property {number | null} [transferSlack]  minimum transfer time, s
 * @property {number | null} [walkSpeed]  m/s
 * @property {number | null} [walkReluctance]  walking time cost multiplier
 * @property {number | null} [boardCost]  cost per boarding, s
 * @property {number | null} [transferCost]  extra cost per transfer, s
 * @property {number} [numResults]  default 3
 */

/**
 * Scheduled times always exist; expected (realtime) times equal the
 * scheduled ones when there is no realtime prediction.
 *
 * @typedef {object} Leg
 * @property {string} mode  WALK, BUS, TRAM, RAIL, SUBWAY, FERRY, ...
 * @property {string | null} line  route short name; null for walking
 * @property {string | null} headsign
 * @property {string} fromName
 * @property {string} toName
 * @property {Date} scheduledStart
 * @property {Date} scheduledEnd
 * @property {Date} start
 * @property {Date} end
 * @property {boolean} realtime
 * @property {number} distanceM
 * @property {[number, number][]} geometry  [lat, lon] shape for the map;
 *   empty when the router has none
 * @property {string | null} routeId  router route id (e.g. "HSL:31M2"), for
 *   live vehicle positions; null for walks or when not requested
 * @property {number | null} directionId  GTFS direction 0/1 of the trip
 * @property {string | null} tripStart  "HH:MM" the trip leaves its first
 *   stop; with route and direction it identifies the vehicle live
 * @property {string | null} [tripId]  router trip id, for the trip's full
 *   stop list (Router.trip); null for walks
 * @property {string | null} [serviceDate]  day the trip runs on, "YYYY-MM-DD"
 * @property {string | null} fromStopId  router stop ids at either end;
 * @property {string | null} toStopId    null where the leg starts/ends
 *   at a street location (first and last walks)
 * @property {string | null} fromStationId  parent station (all platforms
 * @property {string | null} toStationId    of e.g. a metro station), if any
 */

/**
 * @typedef {object} Itinerary
 * @property {Leg[]} legs
 * @property {Date} start
 * @property {Date} end
 * @property {number} numTransfers
 */

/**
 * One stop of a vehicle's trip. Expected times equal the scheduled ones
 * without realtime.
 * @typedef {object} TripStop
 * @property {string} name
 * @property {string} stopId  router stop (platform) id
 * @property {string | null} stationId  parent station, if any
 * @property {number} lat
 * @property {number} lon
 * @property {Date} scheduledArrival
 * @property {Date} arrival
 * @property {Date} scheduledDeparture
 * @property {Date} departure
 * @property {boolean} realtime
 */

/**
 * A vehicle's whole trip: every stop in order and the shape it drives.
 * @typedef {object} Trip
 * @property {TripStop[]} stops
 * @property {[number, number][]} geometry  [lat, lon]; empty if unknown
 */

/**
 * The swap point between routing backends: anything with this shape works.
 *
 * @typedef {object} Router
 * @property {(query: RouteQuery) => Promise<Itinerary[]>} plan
 * @property {(tripId: string, serviceDate: string) => Promise<Trip>} [trip]
 *   a trip's full stop list (for the ride view)
 */

/** @param {Leg} leg */
export const isTransit = (leg) => leg.line !== null;

/** @param {Itinerary} it  @returns {number} seconds */
export const durationS = (it) => (it.end.getTime() - it.start.getTime()) / 1000;

/** The router cannot honour a query parameter (e.g. negative slack). */
export class UnsupportedQuery extends Error {
  name = "UnsupportedQuery";
}
