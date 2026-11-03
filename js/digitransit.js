// @ts-check
/**
 * Router backed by the Digitransit routing API (OpenTripPlanner 2, GraphQL),
 * called directly from the browser with the user's own API key.
 *
 * Query building and response parsing are pure functions so they can be
 * tested against a recorded response without any HTTP.
 */

import { UnsupportedQuery } from "./models.js";
import { decodePolyline } from "./polyline.js";
import { Throttle } from "./ratelimit.js";

/** @typedef {import("./models.js").Place} Place */
/** @typedef {import("./models.js").RouteQuery} RouteQuery */
/** @typedef {import("./models.js").Leg} Leg */
/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./models.js").Trip} Trip */
/** @typedef {import("./geocache.js").GeocodeCache} GeocodeCache */
/** @typedef {import("./places.js").PlaceOption} PlaceOption */

export const ROUTING_URL = "https://api.digitransit.fi/routing/v2/hsl/gtfs/v1";
export const GEOCODING_URL = "https://api.digitransit.fi/geocoding/v1/search";
export const AUTOCOMPLETE_URL = "https://api.digitransit.fi/geocoding/v1/autocomplete";
export const TIMEOUT_MS = 15_000;
// Address autocomplete: the geocoder sometimes takes 10 s+ or answers 504
// (seen 2026-11-02), and a dropdown that waits that long feels stuck.
export const AUTOCOMPLETE_TIMEOUT_MS = 8_000;
// Digitransit asks clients not to burst; one search is only 1-4 requests.
export const MIN_REQUEST_INTERVAL_MS = 1_000;

// Geocoding is restricted to a box around the HSL area and ranked by
// distance from Helsinki railway station. The focus alone is not enough:
// "Otaniemi" otherwise resolved to a street in Uusikaupunki.
const FOCUS = { lat: 60.171, lon: 24.9414 };
const HSL_BBOX = {
  "boundary.rect.min_lat": "59.9",
  "boundary.rect.max_lat": "60.65",
  "boundary.rect.min_lon": "24.0",
  "boundary.rect.max_lon": "25.7",
};

// Variables instead of string interpolation: the server handles escaping and
// type checking, and the query text stays constant.
export const PLAN_QUERY = `
query Plan(
  $origin: PlanLabeledLocationInput!
  $destination: PlanLabeledLocationInput!
  $dateTime: PlanDateTimeInput
  $first: Int
  $last: Int
  $after: String
  $before: String
  $preferences: PlanPreferencesInput
) {
  planConnection(
    origin: $origin
    destination: $destination
    dateTime: $dateTime
    first: $first
    last: $last
    after: $after
    before: $before
    preferences: $preferences
  ) {
    pageInfo { startCursor endCursor }
    edges {
      node {
        start
        end
        numberOfTransfers
        legs {
          mode
          headsign
          distance
          route { shortName gtfsId }
          serviceDate
          trip { gtfsId directionId departureStoptime { scheduledDeparture } }
          from { name stop { gtfsId parentStation { gtfsId } } }
          to { name stop { gtfsId parentStation { gtfsId } } }
          start { scheduledTime estimated { time } }
          end { scheduledTime estimated { time } }
          legGeometry { points }
        }
      }
    }
  }
}
`;

// Every stop and station, for the on-device suggestion index (~1.1 MB,
// fetched about once a week; see places.js).
export const STOPS_QUERY = `
{
  stops { name code lat lon vehicleMode }
  stations { name lat lon vehicleMode }
}
`;

// A vehicle's whole trip on one service day, for the ride view: every stop
// with realtime times, and the shape it drives.
export const TRIP_QUERY = `
query Trip($id: String!, $date: String!) {
  trip(id: $id) {
    tripGeometry { points }
    stoptimesForDate(serviceDate: $date) {
      stop { gtfsId name lat lon parentStation { gtfsId } }
      serviceDay
      scheduledArrival
      realtimeArrival
      scheduledDeparture
      realtimeDeparture
      realtime
    }
  }
}
`;

export class DigitransitError extends Error {
  name = "DigitransitError";
}

/** The caller cancelled (e.g. the user kept typing); not an error to show. */
export const isAbort = (/** @type {unknown} */ e) =>
  e instanceof DOMException && e.name === "AbortError";

/** @param {unknown} v @returns {v is number} set, including 0 */
const isSet = (v) => v !== null && v !== undefined;

/** Seconds -> ISO-8601 duration, e.g. 90 -> "PT90S". @param {number} s */
export const formatDuration = (s) => `PT${Math.trunc(s)}S`;

/**
 * Translate a RouteQuery into planConnection variables.
 * Preferences are only sent when set, so unset fields get server defaults.
 *
 * @param {RouteQuery} query
 * @param {{after?: string | null, before?: string | null}} [page]  cursors
 *   from a previous PlanPage for later / earlier results
 */
export function buildVariables(query, page = {}) {
  if (isSet(query.transferSlack) && query.transferSlack < 0) {
    // OTP's slack is a non-negative duration. Clamping to 0 silently
    // would hide that the user's request was not honoured.
    throw new UnsupportedQuery(
      "Negative transfer slack needs the custom router; " +
        "Digitransit only accepts slack >= 0.",
    );
  }

  /** @param {Place} p */
  const location = (p) => ({
    label: p.name,
    // A stop or station id makes OTP start right at its platforms, without
    // a walk from a street coordinate (used for transfer options).
    location: p.stopId
      ? { stopLocation: { stopLocationId: p.stopId } }
      : { coordinate: { latitude: p.lat, longitude: p.lon } },
  });

  /** @type {Record<string, any>} */
  const preferences = {};

  /** @type {Record<string, any>} */
  const transfer = {};
  if (isSet(query.transferSlack)) transfer.slack = formatDuration(query.transferSlack);
  if (isSet(query.transferCost)) transfer.cost = query.transferCost;
  if (Object.keys(transfer).length) preferences.transit = { transfer };

  /** @type {Record<string, any>} */
  const walk = {};
  if (isSet(query.walkSpeed)) walk.speed = query.walkSpeed;
  if (isSet(query.walkReluctance)) walk.reluctance = query.walkReluctance;
  // boardCost lives under street.walk in the OTP schema, despite being a
  // transit penalty.
  if (isSet(query.boardCost)) walk.boardCost = query.boardCost;
  if (Object.keys(walk).length) preferences.street = { walk };

  /** @type {Record<string, any>} */
  const variables = {
    origin: location(query.origin),
    destination: location(query.destination),
    // Whole seconds in UTC; OTP accepts any offset.
    dateTime: {
      [query.arriveBy ? "latestArrival" : "earliestDeparture"]: query.departAt
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    },
  };
  // Paging (OTP's cursors): "after" pages forward with `first`, "before"
  // pages back with `last`. The cursor carries the original search, so
  // the date/time above is ignored by the server when one is given.
  const n = query.numResults ?? 3;
  if (page.before) {
    variables.before = page.before;
    variables.last = n;
  } else {
    if (page.after) variables.after = page.after;
    variables.first = n;
  }
  if (Object.keys(preferences).length) variables.preferences = preferences;
  return variables;
}

/** @param {any} t LegTime JSON  @returns {[Date, Date]} [scheduled, expected] */
function legTimes(t) {
  const scheduled = new Date(t.scheduledTime);
  // `estimated` is null when there is no realtime prediction.
  const expected = t.estimated ? new Date(t.estimated.time) : scheduled;
  return [scheduled, expected];
}

/**
 * Trip start as "HH:MM", the form HSL's live feed uses in its topics. GTFS
 * counts seconds from the service day's midnight and may pass 24 h for
 * after-midnight trips; the feed uses the plain clock time.
 * @param {number | undefined} s @returns {string | null}
 */
export function tripStartClock(s) {
  if (typeof s !== "number") return null;
  const min = Math.floor((s % 86400) / 60);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** @param {any} raw @returns {Leg} */
function parseLeg(raw) {
  const [scheduledStart, start] = legTimes(raw.start);
  const [scheduledEnd, end] = legTimes(raw.end);
  return {
    mode: raw.mode,
    line: raw.route ? raw.route.shortName : null,
    headsign: raw.headsign ?? null,
    fromName: raw.from.name,
    toName: raw.to.name,
    scheduledStart,
    scheduledEnd,
    start,
    end,
    realtime: raw.start.estimated != null,
    distanceM: raw.distance ?? 0,
    geometry: raw.legGeometry?.points ? decodePolyline(raw.legGeometry.points) : [],
    routeId: raw.route?.gtfsId ?? null,
    // OTP gives "0"/"1" as a string; null for walks.
    directionId: raw.trip?.directionId != null ? Number(raw.trip.directionId) : null,
    tripStart: tripStartClock(raw.trip?.departureStoptime?.scheduledDeparture),
    tripId: raw.trip?.gtfsId ?? null,
    serviceDate: raw.serviceDate ?? null,
    fromStopId: raw.from.stop?.gtfsId ?? null,
    toStopId: raw.to.stop?.gtfsId ?? null,
    fromStationId: raw.from.stop?.parentStation?.gtfsId ?? null,
    toStationId: raw.to.stop?.parentStation?.gtfsId ?? null,
  };
}

/**
 * Turn a planConnection JSON response into Itineraries.
 * @param {any} data @returns {Itinerary[]}
 */
export function parsePlanResponse(data) {
  return parsePlanPage(data).itineraries;
}

/**
 * Itineraries plus the cursors for paging to earlier / later ones.
 * @typedef {{itineraries: Itinerary[], previous: string | null, next: string | null}} PlanPage
 */

/** @param {any} data @returns {PlanPage} */
export function parsePlanPage(data) {
  if (data.errors?.length) {
    const messages = data.errors.map((/** @type {any} */ e) => e.message ?? String(e));
    throw new DigitransitError(`GraphQL error: ${messages.join("; ")}`);
  }
  const conn = data.data.planConnection;
  return {
    itineraries: conn.edges.map(parseNode),
    previous: conn.pageInfo?.startCursor ?? null,
    next: conn.pageInfo?.endCursor ?? null,
  };
}

/** @param {{node: any}} edge @returns {Itinerary} */
function parseNode({ node }) {
  return {
    legs: node.legs.map(parseLeg),
    start: new Date(node.start),
    end: new Date(node.end),
    numTransfers: node.numberOfTransfers,
  };
}

/**
 * Turn a trip query response into a Trip. Stoptimes count seconds from the
 * service day's start (serviceDay, epoch s), passing 24 h after midnight.
 * Names are the stops' own ("Pasila"), as in the plan's legs; the parent
 * station's ("Pasilan asema") would read differently.
 * @param {any} data @returns {Trip}
 */
export function parseTripResponse(data) {
  if (data.errors?.length) {
    const messages = data.errors.map((/** @type {any} */ e) => e.message ?? String(e));
    throw new DigitransitError(`GraphQL error: ${messages.join("; ")}`);
  }
  const trip = data.data.trip;
  if (!trip) throw new DigitransitError("Trip not found (it may have ended).");
  const at = (/** @type {number} */ day, /** @type {number} */ s) => new Date((day + s) * 1000);
  return {
    stops: trip.stoptimesForDate.map((/** @type {any} */ st) => ({
      name: st.stop.name,
      stopId: st.stop.gtfsId,
      stationId: st.stop.parentStation?.gtfsId ?? null,
      lat: st.stop.lat,
      lon: st.stop.lon,
      scheduledArrival: at(st.serviceDay, st.scheduledArrival),
      arrival: at(st.serviceDay, st.realtimeArrival),
      scheduledDeparture: at(st.serviceDay, st.scheduledDeparture),
      departure: at(st.serviceDay, st.realtimeDeparture),
      realtime: Boolean(st.realtime),
    })),
    geometry: trip.tripGeometry?.points ? decodePolyline(trip.tripGeometry.points) : [],
  };
}

export class DigitransitRouter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey  the user's own Digitransit key
   * @param {typeof fetch} [opts.fetch]  injectable for tests
   * @param {{wait: () => Promise<void>}} [opts.throttle]
   * @param {GeocodeCache | null} [opts.geocache]
   */
  constructor({ apiKey, fetch: fetchImpl, throttle, geocache = null }) {
    this.apiKey = apiKey;
    // Bound lazily: calling an unbound window.fetch throws "Illegal invocation".
    this.fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.throttle = throttle ?? new Throttle(MIN_REQUEST_INTERVAL_MS);
    this.geocache = geocache;
  }

  /**
   * Every request goes through here: throttle, key header, errors.
   * `signal` lets the caller cancel: a request cancelled while waiting for
   * its throttle turn is never sent; one in flight is aborted. Either way
   * it rejects with an AbortError (see isAbort).
   * @param {string} url @param {RequestInit} [init]
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   */
  async #request(url, init = {}, { signal, timeoutMs = TIMEOUT_MS } = {}) {
    await this.throttle.wait();
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    let resp;
    try {
      resp = await this.fetch(url, {
        ...init,
        headers: { ...init.headers, "digitransit-subscription-key": this.apiKey },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      // fetch only rejects for transport problems, never for HTTP errors.
      if (signal?.aborted) throw signal.reason;
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new DigitransitError(`Digitransit didn't answer in ${timeoutMs / 1000} s.`);
      }
      throw new DigitransitError("No connection to Digitransit. Check your network.");
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new DigitransitError("API key rejected. Check it in settings.");
    }
    if (resp.status === 429) {
      throw new DigitransitError("Rate limited by Digitransit. Wait a moment.");
    }
    if (resp.status >= 500) {
      // Gateway errors come as HTML pages; say what it means instead.
      throw new DigitransitError(`Digitransit is overloaded or down (HTTP ${resp.status}). Try again.`);
    }
    if (!resp.ok) throw new DigitransitError(`Digitransit HTTP ${resp.status}`);
    return resp.json();
  }

  /** @param {RouteQuery} query @returns {Promise<Itinerary[]>} */
  async plan(query) {
    return (await this.planPage(query)).itineraries;
  }

  /**
   * One page of results; pass a previous page's cursor as `after` (later
   * departures) or `before` (earlier ones) with the same query.
   * @param {RouteQuery} query
   * @param {{after?: string | null, before?: string | null}} [page]
   * @returns {Promise<PlanPage>}
   */
  async planPage(query, page = {}) {
    const data = await this.#request(ROUTING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: PLAN_QUERY, variables: buildVariables(query, page) }),
    });
    return parsePlanPage(data);
  }

  /**
   * A vehicle's whole trip (one request), from a leg's tripId and
   * serviceDate.
   * @param {string} tripId @param {string} serviceDate  a leg's, "YYYY-MM-DD"
   * @returns {Promise<Trip>}
   */
  async trip(tripId, serviceDate) {
    const data = await this.#request(ROUTING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: TRIP_QUERY,
        // Legs give "YYYY-MM-DD"; stoptimesForDate wants "YYYYMMDD".
        variables: { id: tripId, date: serviceDate.replaceAll("-", "") },
      }),
    });
    return parseTripResponse(data);
  }

  /**
   * Resolve free text ("Kamppi", "Mannerheimintie 1") to its top hit.
   * @param {string} text @returns {Promise<Place>}
   */
  async geocode(text) {
    const cached = this.geocache?.get(text);
    if (cached) return cached;

    const params = new URLSearchParams({
      text,
      size: "1",
      "focus.point.lat": String(FOCUS.lat),
      "focus.point.lon": String(FOCUS.lon),
      ...HSL_BBOX,
    });
    const data = await this.#request(`${GEOCODING_URL}?${params}`);
    const feature = data.features?.[0];
    if (!feature) throw new DigitransitError(`No place found for "${text}"`);
    // GeoJSON order is [lon, lat].
    const [lon, lat] = feature.geometry.coordinates;
    const place = { name: feature.properties.label, lat, lon };
    this.geocache?.put(text, place);
    return place;
  }

  /** Session cache: backspacing over a prefix shouldn't refetch it. */
  #autocompleteCache = new Map();

  /**
   * Suggestions for partly typed text (addresses, venues, areas). The
   * caller debounces; this only caches per session (successes only) and
   * throttles. Pass a signal to cancel when the text has changed.
   * @param {string} text @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<PlaceOption[]>}
   */
  async autocomplete(text, { signal } = {}) {
    const key = text.trim().toLowerCase();
    const cached = this.#autocompleteCache.get(key);
    if (cached) return cached;

    const params = new URLSearchParams({
      text,
      size: "5",
      "focus.point.lat": String(FOCUS.lat),
      "focus.point.lon": String(FOCUS.lon),
      ...HSL_BBOX,
    });
    const data = await this.#request(`${AUTOCOMPLETE_URL}?${params}`, {}, {
      signal,
      timeoutMs: AUTOCOMPLETE_TIMEOUT_MS,
    });
    /** @type {PlaceOption[]} */
    // The autocomplete endpoint ignores `size` (checked live 2026-11-01: 10
    // features for size=5), so cap here to keep the dropdown short.
    const options = (data.features ?? []).slice(0, 5).map((/** @type {any} */ f) => {
      const [lon, lat] = f.geometry.coordinates;
      return {
        name: f.properties.label,
        lat,
        lon,
        kind: "address",
        detail: LAYER_LABEL[f.properties.layer] ?? f.properties.layer,
      };
    });
    this.#autocompleteCache.set(key, options);
    return options;
  }

  /**
   * Every stop and station in the region, raw. One large request; callers
   * cache the result (StopStore) and refresh it at most weekly.
   * @returns {Promise<{stops: any[], stations: any[]}>}
   */
  async fetchStops() {
    const data = await this.#request(ROUTING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: STOPS_QUERY }),
    });
    if (data.errors?.length) throw new DigitransitError("Stop list request failed.");
    return data.data;
  }
}

// Pelias layer names -> the grey detail line in suggestions.
const LAYER_LABEL = /** @type {Record<string, string>} */ ({
  address: "Address",
  street: "Street",
  venue: "Place",
  stop: "Stop",
  station: "Station",
  neighbourhood: "Area",
  localadmin: "Area",
  locality: "Town",
});
