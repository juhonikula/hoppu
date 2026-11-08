// @ts-check
/**
 * UI wiring: form <-> RouteQuery <-> router <-> render.js.
 * All routing logic lives in the core modules and all DOM building in
 * render.js; this file reads inputs, calls the router and hands results
 * over. Two search buttons share one flow (search()):
 * - Search: Normal profile, date/time fields, From required.
 * - Hoppu!: Hoppu profile, departs now, empty From = GPS position.
 */

import { DigitransitRouter } from "./digitransit.js";
import { GeocodeCache } from "./geocache.js";
import { HfpClient, legTripKey, mergeCoupled, tripTopic } from "./hfp.js";
import { RouteMap } from "./map.js";
import { Favorites, Recents, StopIndex, StopStore, buildStopIndex, localSuggestions } from "./places.js";
import { byDeparture, fastest, tripKey } from "./analysis.js";
import { HSL_APP_SETTINGS } from "./presets.js";
import {
  renderComparison,
  renderRide,
  renderSummary,
  renderTimeline,
  renderTransferBox,
  renderVersions,
} from "./render.js";
import { applyExit, pickExitOptions, rideProgress, rideShape, rideStops, stopPlace } from "./ride.js";
import { PROFILE_DEFAULTS, loadSettings, profileToQuery, saveSettings } from "./settings.js";
import { PlaceInput } from "./suggest.js";
import { formatClock, formatDayTime, formatMinSec, formatMinutes, helsinkiToDate, helsinkiToday } from "./time.js";
import { SPEED_UNITS, UNIT_LABEL, formatSpeed, parseSpeed, speedInputAttrs } from "./units.js";
import { durationS } from "./models.js";
import {
  TransferTimes,
  applyOption,
  findTransfers,
  leaveAt,
  optionPace,
  nextOptionsRequest,
  optionsOrigin,
  originalBoarding,
  pickOptions,
  transferPace,
} from "./transfers.js";

/** @typedef {import("./models.js").Place} Place */
/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./settings.js").ProfileName} ProfileName */
/** @typedef {import("./settings.js").Profile} Profile */
/** @typedef {import("./suggest.js").Picked} Picked */
/** @typedef {import("./transfers.js").Transfer} Transfer */
/** @typedef {import("./render.js").TransferView} TransferView */
/** @typedef {import("./render.js").RideView} RideView */
/** @typedef {import("./transfers.js").TransferOption} TransferOption */

// --- storage ----------------------------------------------------------------

/**
 * localStorage, or an in-memory stand-in when the browser blocks it (some
 * private modes throw on mere access). The app then works, it just forgets
 * everything on reload.
 * @returns {Pick<Storage, "getItem" | "setItem" | "removeItem">}
 */
function safeStorage() {
  try {
    const s = window.localStorage;
    s.getItem("hoppu.probe");
    return s;
  } catch {
    const m = new Map();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  }
}

const storage = safeStorage();
const KEY_STORAGE = "hoppu.apiKey";

// --- DOM helpers ------------------------------------------------------------

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** @param {string} text @param {boolean} [isError] */
function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// --- app state --------------------------------------------------------------

let settings = loadSettings(storage);
/** @type {DigitransitRouter | null} */
let router = null;
const recents = new Recents(storage);
const favorites = new Favorites(storage);
const stopStore = new StopStore(storage);
/** @type {StopIndex | null} */
let stopIndex = null;
/** Itineraries currently in the list, for the detail view. */
let shown = /** @type {Itinerary[]} */ ([]);
/**
 * The search behind `shown`: transfer options replan to the same
 * destination with the same profile; paging repeats `query` with the
 * cursors (null = no more in that direction). leaveNow: a Hoppu! search,
 * whose routes start at the search time (transfers.js leaveAt).
 * @type {{destination: Place, profile: Profile, query: import("./models.js").RouteQuery,
 *   previous: string | null, next: string | null, leaveNow: boolean} | null}
 */
let lastSearch = null;
/**
 * Transfer box state per itinerary and boarding leg, so options fetched
 * once stay when the detail view is reopened (until the next search).
 * @type {WeakMap<Itinerary, Map<number, TransferView>>}
 */
let transferViews = new WeakMap();
const transferTimes = new TransferTimes(storage);
/**
 * Every version a route has had in the detail view: the planner's first,
 * then each followed option. One array, shared by all its members, so any
 * version finds the others (chips under the map, grey lines on it).
 * @type {WeakMap<Itinerary, Itinerary[]>}
 */
let families = new WeakMap();
/**
 * The open ride sheet (a vehicle's stops as exits), or null.
 * @type {(RideView & {legIndex: number}) | null}
 */
let rideView = null;
/** Index in `shown` of the itinerary in the detail view. */
let detailIndex = -1;
const routeMap = new RouteMap($("map"));

// --- live vehicles ----------------------------------------------------------

/** Latest position per vehicle while the detail view is open. */
const vehicles = /** @type {Map<string, import("./hfp.js").Vehicle>} */ (new Map());
// Positions arrive ~1/s per vehicle; redraw at most once a second.
let vehicleRedraw = /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined);
// A vehicle not heard from for this long has left service or lost GPS.
const VEHICLE_STALE_MS = 60_000;
const hfp = new HfpClient((v) => {
  vehicles.set(v.id, v);
  vehicleRedraw ??= setTimeout(() => {
    vehicleRedraw = undefined;
    const now = Date.now();
    for (const [id, x] of vehicles) if (now - x.at > VEHICLE_STALE_MS) vehicles.delete(id);
    routeMap.setVehicles(mergeCoupled([...vehicles.values()]));
    updateRideProgress();
  }, 1000);
});

/**
 * Follow the vehicles running the itinerary's own trips, plus the trips on
 * any loaded options board (HSL's open MQTT feed, not a Digitransit
 * request). Only those exact trips: not every bus of the line.
 * @param {Itinerary} it
 */
function watchVehicles(it) {
  const legs = [...it.legs];
  for (const v of transferViews.get(it)?.values() ?? []) {
    if (v.status === "done") legs.push(...v.options.map((o) => o.leg));
  }
  const topics = legs
    .filter((l) => l.routeId)
    .map((l) => tripTopic(/** @type {string} */ (l.routeId), l.directionId, l.tripStart));
  // Start clean: followed trips report again within about a second.
  vehicles.clear();
  if (topics.length) hfp.subscribe(topics);
  else hfp.close();
}

function stopVehicles() {
  hfp.close();
  vehicles.clear();
  routeMap.setVehicles([]);
}

/**
 * Star on a dropdown row: save under a name, or remove if already saved.
 * @param {import("./places.js").PlaceOption} p
 */
function toggleFavorite(p) {
  const i = favorites.indexOf(p);
  if (i >= 0) {
    const { label } = favorites.items[i];
    if (confirm(`Remove “${label}” from saved places?`)) favorites.remove(i);
  } else {
    // Default name: the part before the first comma ("Otakaari 1").
    const label = prompt("Name for this place (e.g. Home):", p.name.split(",")[0]);
    if (label !== null) favorites.add(label, p);
  }
  renderChips();
}

const suggestOpts = {
  local: (/** @type {string} */ t) => localSuggestions(t, recents, stopIndex, favorites),
  star: { isSaved: (/** @type {any} */ p) => favorites.indexOf(p) >= 0, toggle: toggleFavorite },
  remote: (/** @type {string} */ t, /** @type {AbortSignal} */ signal) => {
    if (!router) return Promise.resolve([]);
    return router.autocomplete(t, { signal });
  },
};
const fromField = new PlaceInput(input("from"), $("from-list"), { ...suggestOpts, offerMyLocation: true });
const toField = new PlaceInput(input("to"), $("to-list"), suggestOpts);

function initRouter() {
  const key = storage.getItem(KEY_STORAGE);
  router = key
    ? new DigitransitRouter({ apiKey: key, geocache: new GeocodeCache(storage) })
    : null;
  $("key-setup").hidden = router !== null;
  $("search-form").hidden = router === null;
}

/**
 * Load the stop index from storage, and refresh it in the background when
 * it's missing or a week old (one throttled request, ~1 MB).
 */
async function loadStops() {
  const saved = stopStore.load();
  if (saved) stopIndex = new StopIndex(saved.entries);
  if (!router || !navigator.onLine || !stopStore.isStale(Date.now())) return;
  try {
    const { stops, stations } = await router.fetchStops();
    const entries = buildStopIndex(stops, stations);
    stopStore.save(entries, Date.now());
    stopIndex = new StopIndex(entries);
  } catch (e) {
    // Suggestions fall back to the API; retried on the next start.
    console.warn("Stop list not refreshed:", e);
  }
}

// --- search -----------------------------------------------------------------

/** @returns {Promise<Place>} */
function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(new Error(`Location failed: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

/**
 * Text field -> place. A picked suggestion is used as is; typed text that
 * exactly names a stop group resolves locally; anything else goes to the
 * geocoder (cached).
 * @param {PlaceInput} field @returns {Promise<Place>}
 */
async function resolvePlace(field) {
  const p = field.picked;
  if (p?.kind === "gps") return currentPosition();
  if (p) return { name: p.name, lat: p.lat, lon: p.lon };
  const text = field.input.value.trim();
  const local = stopIndex?.exact(text);
  if (local) return { name: local.name, lat: local.lat, lon: local.lon };
  if (!router) throw new Error("No API key.");
  return router.geocode(text);
}

/** @param {ProfileName} mode */
async function search(mode) {
  if (!router) return;
  const profile = settings[mode];
  const fromText = input("from").value.trim();
  const toText = input("to").value.trim();
  if (!toText) {
    setStatus("Where to? Fill in To.", true);
    input("to").focus();
    return;
  }
  if (!fromText) {
    if (mode === "normal") {
      setStatus("Fill in From, or use Hoppu! to start from your location.", true);
      input("from").focus();
      return;
    }
    fromField.set({ kind: "gps", name: "My location" });
  }

  if (mode === "normal" && timeMode() === "arrive" && !input("time").value) {
    setStatus("Arrive by needs a time.", true);
    input("time").focus();
    return;
  }

  const buttons = /** @type {HTMLButtonElement[]} */ ([$("search"), $("hoppu-now")]);
  for (const b of buttons) b.disabled = true;
  $("results").replaceChildren();
  $("load-earlier").hidden = true;
  $("load-later").hidden = true;
  $("comparison").hidden = true;
  try {
    // Sequential on purpose: the throttle spaces requests 1 s apart anyway.
    setStatus(fromField.picked?.kind === "gps" ? "Locating…" : "Finding places…");
    const origin = await resolvePlace(fromField);
    const destination = await resolvePlace(toField);
    // Saved places and GPS don't need to show up as recents too.
    if (!["gps", "favorite"].includes(fromField.picked?.kind ?? "")) recents.add(origin);
    if (toField.picked?.kind !== "favorite") recents.add(destination);

    const time = input("time").value;
    const arriveBy = mode === "normal" && timeMode() === "arrive";
    const departAt =
      mode === "hoppu" || !time ? new Date() : helsinkiToDate(input("date").value, time);
    const query = { origin, destination, departAt, arriveBy };
    setStatus("Planning…");
    const full = { ...query, ...profileToQuery(profile) };
    const page = await router.planPage(full);
    // Hoppu! means leaving now: walk to the first stop right away and wait
    // there, instead of the planner's "leave at the last moment". Earlier
    // and later pages keep the planner's times (asked for explicitly).
    const leaveNow = mode === "hoppu";
    const itineraries = byDeparture(leaveNow ? page.itineraries.map((it) => leaveAt(it, departAt)) : page.itineraries);
    shown = itineraries;
    lastSearch = { destination, profile, query: full, previous: page.previous, next: page.next, leaveNow };
    transferViews = new WeakMap();
    families = new WeakMap();
    renderResults();
    // Hoppu! is "get me there now": straight to the fastest result. Back
    // returns to the list, since openDetail pushes a history entry.
    if (mode === "hoppu" && itineraries.length) openDetail(fastest(itineraries));

    let baseline = null;
    // Arrive-by: "earliest arrival" isn't what's being optimised, so the
    // HSL comparison (which compares arrivals) is skipped.
    if (profile.compare && itineraries.length && !arriveBy) {
      setStatus("Comparing with HSL app settings…");
      baseline = await router.plan({ ...query, ...HSL_APP_SETTINGS, numResults: profile.numResults });
    }
    renderComparison($("comparison"), itineraries, baseline);
    const label = mode === "hoppu" ? "hoppu settings" : "normal settings";
    setStatus(
      itineraries.length
        ? `${origin.name} → ${destination.name} · ${label}`
        : "No routes found.",
    );
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

/**
 * Walk/run estimate for a transfer: the searched profile's speeds over the
 * walking distance, or the saved own time for that transfer.
 * @param {Transfer} t
 */
function paceFor(t) {
  const p = lastSearch?.profile ?? settings.hoppu;
  return transferPace(t, { walkMps: p.walkKmh / 3.6, runMps: p.runKmh / 3.6, own: transferTimes.get(t.key) });
}

/**
 * Walk/run estimate per option: its own walk distance, and the own time
 * saved for the station pair it changes between.
 * @param {TransferOption[]} options
 */
function pacesFor(options) {
  const p = lastSearch?.profile ?? settings.hoppu;
  return options.map((o) =>
    optionPace(o, { walkMps: p.walkKmh / 3.6, runMps: p.runKmh / 3.6, own: transferTimes.get(o.boardKey) }),
  );
}

/** (Re)draw the result cards from `shown`, and the paging buttons. */
function renderResults() {
  // Tapping a vehicle on a card: the detail view, with that ride open.
  const onRide = (/** @type {Itinerary} */ it, /** @type {number} */ i) => {
    openDetail(it);
    openRide(i);
  };
  $("results").replaceChildren(...shown.map((it) => renderSummary(it, openDetail, paceFor, onRide)));
  $("load-earlier").hidden = !shown.length || !lastSearch?.previous;
  $("load-later").hidden = !shown.length || !lastSearch?.next;
}

/** @returns {"leave" | "arrive"} */
const timeMode = () =>
  /** @type {HTMLInputElement} */ (document.querySelector('input[name="time-mode"]:checked'))
    .value === "arrive" ? "arrive" : "leave";

/**
 * Load the page before or after the current results (one request) and
 * merge it in, sorted and without duplicates.
 * @param {"earlier" | "later"} dir
 */
async function loadPage(dir) {
  if (!router || !lastSearch) return;
  const search = lastSearch;
  const button = /** @type {HTMLButtonElement} */ ($(dir === "earlier" ? "load-earlier" : "load-later"));
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const page = await router.planPage(
      search.query,
      dir === "earlier" ? { before: search.previous } : { after: search.next },
    );
    // A new search started meanwhile: drop this page.
    if (lastSearch !== search) return;
    const seen = new Set(shown.map(tripKey));
    const fresh = page.itineraries.filter((it) => !seen.has(tripKey(it)));
    shown = byDeparture([...shown, ...fresh]);
    if (dir === "earlier") search.previous = fresh.length ? page.previous : null;
    else search.next = fresh.length ? page.next : null;
    renderResults();
    if (!fresh.length) setStatus(`No ${dir} options found.`);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// --- detail view ------------------------------------------------------------

/**
 * Opening pushes a history entry, so the phone's back button (popstate)
 * closes the detail instead of leaving the app.
 * @param {Itinerary} it
 */
function openDetail(it) {
  const index = shown.indexOf(it);
  history.pushState({ detail: index }, "");
  showDetail(index);
}

/** @param {number} index */
function showDetail(index) {
  const it = shown[index];
  if (!it) {
    hideDetail();
    return;
  }
  detailIndex = index;
  hideRide();
  $("detail-title").textContent =
    `${formatClock(it.start)} → ${formatClock(it.end)} · ${formatMinutes(durationS(it))}`;
  const family = families.get(it) ?? [it];
  $("versions").replaceChildren(...renderVersions(family, it, switchVersion));
  $("versions").hidden = family.length < 2;
  const transfers = transfersOf(it);
  const boxes = transferBoxes(it, transfers);
  $("timeline").replaceChildren(
    ...renderTimeline(it, { extra: (i) => boxes.get(i) ?? null, paceFor, onRide: openRide, transfers }),
  );
  $("main-view").hidden = true;
  $("detail").hidden = false;
  $("detail").scrollTop = 0;
  // After unhiding: Leaflet measures its container.
  routeMap.show(it, { onLeg: openRide });
  // The versions left behind, grey where they differ; tap to go back.
  routeMap.showGhosts(
    family.filter((x) => x !== it).map((x) => ({ it: x, onTap: () => switchVersion(x) })),
    it,
  );
  // Options loaded earlier for this route go back on the map.
  for (const v of transferViews.get(it)?.values() ?? []) {
    if (v.status === "done") drawOptions(it, v);
  }
  routeMap.setVehicles([]);
  // Tapping a live vehicle of this route opens its ride; one of a loaded
  // option follows that option, like tapping its row.
  routeMap.onVehicle = (vehicle) => {
    const i = it.legs.findIndex((l) => legTripKey(l) === vehicle.trip);
    if (i >= 0) {
      openRide(i);
      return;
    }
    for (const v of transferViews.get(it)?.values() ?? []) {
      const o = v.status === "done" && v.options.find((x) => legTripKey(x.leg) === vehicle.trip);
      if (o) {
        chooseOption(it, v, o);
        return;
      }
    }
  };
  watchVehicles(it);
}

// --- transfer options -------------------------------------------------------

/**
 * Every boarding of `it`, the first one included. The first counts from
 * the search's leave-at time (now for Hoppu! and "now" searches), so it
 * shows how much time you really have to get to the stop; arrive-by
 * searches count from the plan's start (transfers.js findTransfers).
 * @param {Itinerary} it @returns {Transfer[]}
 */
function transfersOf(it) {
  const q = lastSearch?.query;
  return findTransfers(it, { includeFirst: true, setOff: q && !q.arriveBy ? q.departAt : null });
}

/**
 * One container per transfer in `it`, keyed by the boarding leg index.
 * Each is re-rendered in place when its state changes.
 * @param {Itinerary} it @param {Transfer[]} transfers  from transfersOf
 * @returns {Map<number, HTMLElement>}
 */
function transferBoxes(it, transfers) {
  let views = transferViews.get(it);
  if (!views) {
    views = new Map();
    transferViews.set(it, views);
  }
  const boxes = new Map();
  for (const t of transfers) {
    const box = document.createElement("div");
    boxes.set(t.legIndex, box);
    const old = views.get(t.legIndex);
    // Pace may have changed (own time saved, speeds edited); options stay
    // valid since they're fetched from the arrival, not from a pace.
    views.set(t.legIndex, withPace(old ?? /** @type {TransferView} */ ({ transfer: t, status: "idle", options: [] })));
    const render = () => {
      const v = /** @type {TransferView} */ (views.get(t.legIndex));
      box.replaceChildren(
        renderTransferBox(v, {
          onShow: () => loadOptions(it, v, render),
          onToggleOwn: () => {
            views.set(t.legIndex, { ...v, ownOpen: !v.ownOpen });
            render();
          },
          onChoose: (o) => chooseOption(it, /** @type {TransferView} */ (views.get(t.legIndex)), o),
          // Own time changes every colour on this route: redraw it all.
          // Each save is one more sample; its distance feeds the average
          // pace in settings.
          onSaveOwn: (sec, mode) => {
            transferTimes.add(/** @type {string} */ (t.key), `${t.fromName} → ${t.toName}`, {
              seconds: sec,
              mode,
              distanceM: t.distanceM,
            });
            views.set(t.legIndex, { ...v, ownOpen: false });
            renderResults();
            showDetail(detailIndex);
          },
          onClearOwn: () => {
            transferTimes.remove(/** @type {string} */ (t.key));
            renderResults();
            showDetail(detailIndex);
          },
        }),
      );
    };
    render();
  }
  return boxes;
}

/**
 * Follow a transfer option: the itinerary becomes the original up to the
 * transfer (fewer legs when planned from elsewhere: v.keepLegs) plus the
 * option's plan. No request: the option's plan is already loaded. An
 * option for the first boarding of a Hoppu! route also leaves now.
 * @param {Itinerary} it @param {TransferView} v @param {TransferOption} o
 */
function chooseOption(it, v, o) {
  const next = applyOption(it, v.transfer, o.plan, v.keepLegs);
  follow(it, v.transfer.first && lastSearch?.leaveNow ? leaveAt(next, v.transfer.arrival) : next);
}

/**
 * `next` replaces `it` in the list and becomes the newest version of its
 * route; the detail view redraws, so the new route's transfers get their
 * own boxes and the old one turns into a grey line and a chip.
 * @param {Itinerary} it @param {Itinerary} next
 */
function follow(it, next) {
  const index = shown.indexOf(it);
  if (index < 0) return;
  const family = families.get(it) ?? [it];
  family.push(next);
  families.set(it, family);
  families.set(next, family);
  shown[index] = next;
  renderResults();
  showDetail(index);
}

/** Show another version of the open route (a chip or a grey line). @param {Itinerary} version */
function switchVersion(version) {
  if (!shown[detailIndex] || shown[detailIndex] === version) return;
  shown[detailIndex] = version;
  renderResults();
  showDetail(detailIndex);
}

/** Current own times and walk/run estimates for a view. @param {TransferView} v */
function withPace(v) {
  const key = v.transfer.key;
  return {
    ...v,
    own: transferTimes.get(key),
    ownCount: transferTimes.count(key),
    pace: paceFor(v.transfer),
    paces: pacesFor(v.options),
  };
}

/**
 * A transfer's loaded options on the map as faded dashed lines (all of
 * them, also the ones too short even running: a delay can make those).
 * @param {Itinerary} it @param {TransferView} v
 */
function drawOptions(it, v) {
  routeMap.showOptions(v.options, (o) => chooseOption(it, v, o));
}

/**
 * Plan a transfer's options from the stop where the previous vehicle drops
 * you, from 10 min before the plan's time there (first boarding: the
 * search origin and start; transfers.js optionsOrigin), then 20 and 30 min
 * before while fewer than 2 departures before the planned one turn up
 * (one request each; transfers.js nextOptionsRequest). Keep 2 before, the
 * planned one, 2 after and the original route's departure. Every tap
 * fetches afresh (realtime moves).
 * @param {Itinerary} it @param {TransferView} v @param {() => void} render
 */
async function loadOptions(it, v, render) {
  const views = transferViews.get(it);
  if (!router || !lastSearch || !views) return;
  const search = lastSearch;
  views.set(v.transfer.legIndex, { ...v, status: "loading" });
  render();
  try {
    const from = optionsOrigin(it, v.transfer, search.query.origin);
    const t = v.transfer;
    const original = originalBoarding((families.get(it) ?? [it])[0], t);
    /** @type {Itinerary[]} */
    const plans = [];
    /** @type {TransferOption[]} */
    let options = [];
    // Sequential: each request depends on what the previous ones found.
    for (
      let req = nextOptionsRequest(t, options, { backS: 0, later: false });
      req;
      req = nextOptionsRequest(t, options, req)
    ) {
      plans.push(
        ...(await router.plan({
          origin: from.origin,
          destination: search.destination,
          // From before you arrive: every departure you could make, also
          // the ones too close even running (judged by pace on display).
          departAt: req.departAt,
          ...profileToQuery(search.profile),
          // Room for the departures in the look-back up to the planned one,
          // plus 2 after.
          numResults: 12,
        })),
      );
      options = pickOptions(plans, t, it.end, from, original);
    }
    const done = {
      ...v,
      status: /** @type {const} */ ("done"),
      options,
      paces: pacesFor(options),
      fromName: from.origin.name,
      keepLegs: from.keepLegs,
    };
    views.set(t.legIndex, done);
    drawOptions(it, done);
    // Add the option trips' vehicles to the map.
    watchVehicles(it);
  } catch (e) {
    views.set(v.transfer.legIndex, { ...v, status: "error", error: e instanceof Error ? e.message : String(e) });
  }
  render();
}

// --- ride view --------------------------------------------------------------

/**
 * Open the ride sheet for a vehicle leg of the route in the detail view.
 * It has its own history entry: back closes it.
 * @param {number} legIndex
 */
function openRide(legIndex) {
  history.pushState({ detail: detailIndex, ride: legIndex }, "");
  showRide(legIndex);
}

/** Fetch the vehicle's trip (one request) and show its stops. @param {number} legIndex */
async function showRide(legIndex) {
  const it = shown[detailIndex];
  const leg = it?.legs[legIndex];
  if (!it || !leg?.line) return;
  /** @type {RideView & {legIndex: number}} */
  const r = { leg, legIndex, status: "loading", ride: null, progress: null, stops: new Map() };
  rideView = r;
  $("ride").hidden = false;
  $("detail").scrollTop = 0; // the map, above the sheet, in view
  renderRideSheet();
  try {
    if (!router || !leg.tripId || !leg.serviceDate) throw new Error("No trip details for this vehicle.");
    const trip = await router.trip(leg.tripId, leg.serviceDate);
    if (rideView !== r) return; // closed or replaced meanwhile
    r.ride = rideStops(leg, trip);
    if (!r.ride) throw new Error("This vehicle's stops weren't found.");
    r.status = "done";
    updateRideProgress(false);
    const ride = r.ride;
    routeMap.showRide(ride, leg.mode, rideShape(ride, ride.exitIndex, ride.stops.length - 1), toggleExit);
    routeMap.fit(
      ride.stops.map((s) => [s.lat, s.lon]),
      Math.max(0, $("map").getBoundingClientRect().bottom - $("ride").getBoundingClientRect().top),
    );
  } catch (e) {
    if (rideView !== r) return;
    r.status = "error";
    r.error = e instanceof Error ? e.message : String(e);
  }
  renderRideSheet();
}

function renderRideSheet() {
  const r = rideView;
  if (!r) return;
  $("ride").replaceChildren(
    ...renderRide(r, {
      onClose: () => history.back(),
      onRetry: () => showRide(r.legIndex),
      onToggle: toggleExit,
      onChoose: chooseExit,
    }),
  );
}

function hideRide() {
  rideView = null;
  $("ride").hidden = true;
  $("ride").replaceChildren();
  routeMap.clearRide();
  routeMap.clearOptions();
}

/**
 * Where the ride's vehicle is now, from the live feed; the sheet redraws
 * only when that changes stop-wise (not on every position).
 * @param {boolean} [redraw]
 */
function updateRideProgress(redraw = true) {
  const r = rideView;
  if (!r?.ride) return;
  const key = legTripKey(r.leg);
  const v = key ? [...vehicles.values()].find((x) => x.trip === key) : undefined;
  const p = v ? rideProgress(r.ride, v) : null;
  /** @param {import("./ride.js").RideProgress | null} q */
  const where = (q) => (q ? `${q.after}|${q.fraction > 0.05}|${q.coming?.stopsAway}|${q.coming?.prev}` : "");
  const changed = where(p) !== where(r.progress);
  r.progress = p;
  if (changed && redraw) renderRideSheet();
}

/**
 * "Get off here": load exit options for stop i (one request, fresh every
 * time), or hide them again. They show as a board under the stop and as
 * dashed lines on the map; nothing is chosen until a row is tapped.
 * @param {number} i
 */
async function toggleExit(i) {
  const r = rideView;
  const it = shown[detailIndex];
  if (!r?.ride || !it || !router || !lastSearch) return;
  const shownView = r.stops.get(i);
  if (shownView?.status === "loading") return;
  if (shownView) {
    r.stops.delete(i);
    routeMap.clearOptions();
    renderRideSheet();
    return;
  }
  const ride = r.ride;
  const stop = ride.stops[i];
  r.stops.set(i, { status: "loading", options: [], paces: [] });
  renderRideSheet();
  try {
    const plans = await router.plan({
      origin: { name: stop.name, lat: stop.lat, lon: stop.lon, stopId: stopPlace(stop) },
      destination: lastSearch.destination,
      departAt: stop.arrival,
      ...profileToQuery(lastSearch.profile),
      numResults: 8,
    });
    if (rideView !== r) return;
    const options = pickExitOptions(plans, it, r.legIndex, stop, i === ride.exitIndex);
    const view = { status: /** @type {const} */ ("done"), options, paces: pacesFor(options) };
    r.stops.set(i, view);
    // Only this stop's options on the map (the latest one opened).
    routeMap.showOptions(options, (o) => chooseExit(i, o));
  } catch (e) {
    if (rideView !== r) return;
    r.stops.set(i, { status: "error", options: [], paces: [], error: e instanceof Error ? e.message : String(e) });
  }
  renderRideSheet();
}

/**
 * Follow an exit option: the ride is cut (or extended) to stop i and the
 * option's plan follows. The sheet closes on the new route.
 * @param {number} i @param {TransferOption} o
 */
function chooseExit(i, o) {
  const r = rideView;
  const it = shown[detailIndex];
  if (!r?.ride || !it) return;
  const next = applyExit(it, r.legIndex, r.ride, i, o.plan);
  // The sheet's history entry goes; popstate then shows the new version.
  hideRide();
  follow(it, next);
  history.back();
}

function hideDetail() {
  hideRide();
  stopVehicles();
  $("detail").hidden = true;
  $("main-view").hidden = false;
}

// --- settings sheet ---------------------------------------------------------

/**
 * The settings fields, shared by both profile tabs. nullable fields may be
 * left empty = router default.
 * speed: a walking/running speed, shown in the sheet's speed unit (km/h
 * range given; units.js), stored in km/h.
 * @type {{key: keyof Profile, label: string, step: string, min: string, max?: string, nullable?: boolean,
 *   speed?: {min: number, max: number}}[]}
 */
const FIELDS = [
  { key: "slackMin", label: "Transfer margin (min)", step: "0.5", min: "0" },
  { key: "walkKmh", label: "Walking speed", step: "0.5", min: "1", max: "20", speed: { min: 1, max: 20 } },
  { key: "runKmh", label: "Running speed", step: "0.5", min: "1", max: "30", speed: { min: 1, max: 30 } },
  { key: "walkReluctance", label: "Walk reluctance", step: "0.1", min: "0.1", nullable: true },
  { key: "boardCost", label: "Board cost (s)", step: "10", min: "0", nullable: true },
  { key: "transferCost", label: "Transfer cost (s)", step: "10", min: "0", nullable: true },
  { key: "numResults", label: "Results", step: "1", min: "1", max: "10" },
];

const PROFILE_HINT = {
  normal: "Used by Search. Defaults: the HSL app's transfer margin and costs at a normal walking pace.",
  hoppu: "Used by Hoppu! Defaults: no transfer margin, 8 km/h, walking not penalised.",
};

/** @param {ProfileName} name */
function buildProfilePanel(name) {
  const panel = $(`panel-${name}`);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = PROFILE_HINT[name];

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const f of FIELDS) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.id = `${name}-${f.key}-label`;
    span.textContent = f.label;
    const el = document.createElement("input");
    el.id = `${name}-${f.key}`;
    el.type = "number";
    el.step = f.step;
    el.min = f.min;
    if (f.max) el.max = f.max;
    el.inputMode = f.step.includes(".") ? "decimal" : "numeric";
    if (f.nullable) el.placeholder = "server default";
    label.append(span, el);
    if (f.speed) {
      // The same speed in the other units, small and grey.
      const conv = document.createElement("span");
      conv.className = "speed-conv";
      conv.id = `${name}-${f.key}-conv`;
      // Your average from the transfer time log (shown only, never used).
      const avg = document.createElement("span");
      avg.className = "speed-conv";
      avg.id = `${name}-${f.key}-avg`;
      label.append(conv, avg);
    }
    grid.append(label);
  }

  // Speed unit for both profiles: switching here redraws both panels.
  const unitLabel = document.createElement("span");
  unitLabel.className = "unit-seg-label";
  unitLabel.textContent = "Speed unit";
  const seg = document.createElement("div");
  seg.className = "unit-seg";
  seg.id = `${name}-unit`;
  for (const u of SPEED_UNITS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.unit = u;
    b.textContent = UNIT_LABEL[u];
    b.addEventListener("click", () => {
      settings = { ...settings, speedUnit: u };
      saveSettings(storage, settings);
      fillProfilePanel("normal");
      fillProfilePanel("hoppu");
    });
    seg.append(b);
  }

  const compare = document.createElement("label");
  compare.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = `${name}-compare`;
  const text = document.createElement("span");
  text.textContent = "Compare with HSL app settings (one extra request per search)";
  compare.append(box, text);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "secondary";
  reset.textContent = `Reset ${name === "normal" ? "Normal" : "Hoppu"} to defaults`;
  reset.addEventListener("click", () => {
    settings[name] = { ...PROFILE_DEFAULTS[name] };
    saveSettings(storage, settings);
    fillProfilePanel(name);
  });

  const negative = document.createElement("p");
  negative.className = "hint";
  negative.textContent =
    "Transfers are judged by your walking and running speeds over the transfer's walking " +
    "distance: purple ones you only make by running. In a route's details, “Show options " +
    "here” lists what you could catch at that station.";

  panel.append(hint, unitLabel, seg, grid, negative, compare, reset);
  // Save on every keystroke ("input", not "change": change only fires on
  // blur, and closing the sheet with Escape could skip it). There is no
  // separate Save button.
  panel.addEventListener("input", () => readProfilePanel(name));
  // Leaving a speed field tidies what was typed ("5,30" -> "5:30").
  panel.addEventListener("focusout", (e) => {
    const f = FIELDS.find((x) => x.speed && `${name}-${x.key}` === /** @type {HTMLElement} */ (e.target).id);
    if (f) input(`${name}-${f.key}`).value = formatSpeed(/** @type {number} */ (settings[name][f.key]), settings.speedUnit);
  });
}

/**
 * Show a profile in the sheet, speeds in the current speed unit: labels,
 * input type and range (pace is typed as text), values, conversion lines.
 * @param {ProfileName} name
 */
function fillProfilePanel(name) {
  const p = settings[name];
  const unit = settings.speedUnit;
  for (const b of $(`${name}-unit`).querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.unit === unit));
  }
  for (const f of FIELDS) {
    const el = input(`${name}-${f.key}`);
    if (!f.speed) {
      el.value = p[f.key]?.toString() ?? "";
      continue;
    }
    const attrs = speedInputAttrs(unit, f.speed);
    el.type = attrs.type;
    el.inputMode = attrs.inputMode;
    for (const a of /** @type {const} */ (["step", "min", "max", "placeholder"])) {
      if (attrs[a] === undefined) el.removeAttribute(a);
      else el.setAttribute(a, attrs[a]);
    }
    el.value = formatSpeed(/** @type {number} */ (p[f.key]), unit);
    $(`${name}-${f.key}-label`).textContent = `${f.label} (${UNIT_LABEL[unit]})`;
    showSpeedConv(name, f.key);
  }
  showAveragePace(name);
  input(`${name}-compare`).checked = p.compare;
}

/**
 * "Your average: 7.4 km/h (5 transfers)" under the walking and running
 * speed, from the transfer time log; hidden without samples.
 * @param {ProfileName} name
 */
function showAveragePace(name) {
  const pace = transferTimes.averagePace();
  for (const [key, avg] of /** @type {const} */ ([["walkKmh", pace.walk], ["runKmh", pace.run]])) {
    const el = $(`${name}-${key}-avg`);
    el.hidden = !avg;
    if (avg) {
      el.textContent =
        `Your average: ${formatSpeed(avg.kmh, settings.speedUnit)} ${UNIT_LABEL[settings.speedUnit]} ` +
        `(${avg.n} transfer${avg.n === 1 ? "" : "s"})`;
    }
  }
}

/** "= 2.22 m/s · 7:30 min/km" under a speed field. @param {ProfileName} name @param {keyof Profile} key */
function showSpeedConv(name, key) {
  const kmh = /** @type {number} */ (settings[name][key]);
  $(`${name}-${key}-conv`).textContent =
    "= " + SPEED_UNITS.filter((u) => u !== settings.speedUnit).map((u) => `${formatSpeed(kmh, u)} ${UNIT_LABEL[u]}`).join(" · ");
}

/** @param {ProfileName} name */
function readProfilePanel(name) {
  const p = /** @type {Record<string, any>} */ ({ ...settings[name] });
  for (const f of FIELDS) {
    const raw = input(`${name}-${f.key}`).value.trim();
    if (f.speed) {
      // Empty: the profile default. Half-typed ("7:"): keep the last
      // valid speed until the text parses.
      p[f.key] = raw === "" ? PROFILE_DEFAULTS[name][f.key] : (parseSpeed(raw, settings.speedUnit) ?? p[f.key]);
      continue;
    }
    const n = raw === "" ? null : Number(raw);
    // Empty or invalid: router default where allowed, else the profile default.
    p[f.key] = n !== null && Number.isFinite(n) ? n : f.nullable ? null : PROFILE_DEFAULTS[name][f.key];
  }
  p.compare = input(`${name}-compare`).checked;
  settings = { ...settings, [name]: /** @type {Profile} */ (p) };
  saveSettings(storage, settings);
  for (const f of FIELDS) if (f.speed) showSpeedConv(name, f.key);
}

/** @param {ProfileName} name */
function selectTab(name) {
  for (const n of /** @type {ProfileName[]} */ (["normal", "hoppu"])) {
    $(`tab-${n}`).setAttribute("aria-selected", String(n === name));
    $(`panel-${n}`).hidden = n !== name;
  }
}

/** Saved places as chips under To: a tap fills To. */
function renderChips() {
  const chips = $("favorite-chips");
  chips.hidden = favorites.items.length === 0;
  chips.replaceChildren(
    ...favorites.items.map((f) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = f.label;
      b.title = f.place.name;
      b.addEventListener("click", () => toField.set(Favorites.option(f)));
      return b;
    }),
  );
}

/** Saved places in settings: reorder, rename, remove. */
function renderFavoritesList() {
  $("favorites-empty").hidden = favorites.items.length > 0;
  /** @param {string} text @param {string} label @param {() => void} action @param {string} [cls] */
  const btn = (text, label, action, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `secondary small ${cls}`;
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => {
      action();
      renderFavoritesList();
      renderChips();
    });
    return b;
  };
  $("favorites-list").replaceChildren(
    ...favorites.items.map((f, i) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "fav-text";
      const name = document.createElement("strong");
      name.textContent = f.label;
      const where = document.createElement("span");
      where.className = "fav-place";
      where.textContent = f.place.name;
      text.append(name, where);
      const actions = document.createElement("span");
      actions.className = "fav-actions";
      actions.append(
        btn("↑", `Move ${f.label} up`, () => favorites.move(i, -1)),
        btn("↓", `Move ${f.label} down`, () => favorites.move(i, 1)),
        btn("Rename", `Rename ${f.label}`, () => {
          const label = prompt("New name:", f.label);
          if (label !== null) favorites.rename(i, label);
        }),
        btn("Remove", `Remove ${f.label}`, () => favorites.remove(i), "danger"),
      );
      li.append(text, actions);
      return li;
    }),
  );
}

/** The saved own transfer times, each with a Remove button. */
function renderTransferTimes() {
  const items = transferTimes.list();
  $("transfer-times-empty").hidden = items.length > 0;
  /** After a change: the list, and the average pace under the speeds. */
  const changed = () => {
    renderTransferTimes();
    showAveragePace("normal");
    showAveragePace("hoppu");
  };
  /** @param {string} cls @param {string} text @param {() => void} onClick */
  const button = (cls, text, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  };
  $("transfer-times").replaceChildren(
    ...items.map((x) => {
      // One pair per row with its averages; open it for the samples.
      const li = document.createElement("li");
      const details = document.createElement("details");
      details.className = "pair";
      const summary = document.createElement("summary");
      const avg = document.createElement("span");
      avg.className = "pair-avg";
      const walks = x.samples.filter((y) => y.mode === "walk").length;
      avg.textContent = [
        x.own.walkS !== null && `walked ${formatMinSec(x.own.walkS)} (${walks})`,
        x.own.runS !== null && `ran ${formatMinSec(x.own.runS)} (${x.samples.length - walks})`,
      ].filter(Boolean).map((t) => ` · ${t}`).join("");
      summary.append(x.label, avg);
      const list = document.createElement("ul");
      list.className = "samples";
      x.samples.forEach((y, i) => {
        const row = document.createElement("li");
        const when = y.at ? ` · ${formatDayTime(new Date(y.at))}` : "";
        row.append(
          `${formatMinSec(y.s)} ${y.mode === "walk" ? "walked" : "ran"}${when}`,
          button("secondary small danger", "Delete", () => {
            transferTimes.removeSample(x.key, i);
            changed();
          }),
        );
        list.append(row);
      });
      const all = document.createElement("li");
      all.append(button("secondary small danger", "Remove all", () => {
        transferTimes.remove(x.key);
        changed();
      }));
      list.append(all);
      details.append(summary, list);
      li.append(details);
      return li;
    }),
  );
}

// --- startup ----------------------------------------------------------------

function main() {
  initRouter();
  renderChips();
  input("date").value ||= helsinkiToday();
  for (const n of /** @type {ProfileName[]} */ (["normal", "hoppu"])) {
    buildProfilePanel(n);
    fillProfilePanel(n);
    $(`tab-${n}`).addEventListener("click", () => selectTab(n));
  }
  loadStops();

  $("key-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = input("key-input").value.trim();
    if (!key) return;
    storage.setItem(KEY_STORAGE, key);
    input("key-input").value = "";
    initRouter();
    loadStops();
    setStatus("Key saved on this device.");
  });

  const sheet = /** @type {HTMLDialogElement} */ ($("settings"));
  $("open-settings").addEventListener("click", () => {
    renderTransferTimes();
    // Times saved in a route since the sheet was filled change the average.
    showAveragePace("normal");
    showAveragePace("hoppu");
    renderFavoritesList();
    sheet.showModal();
  });
  $("close-settings").addEventListener("click", () => sheet.close());
  $("forget-key").addEventListener("click", () => {
    storage.removeItem(KEY_STORAGE);
    initRouter();
    sheet.close();
    setStatus("API key removed from this device.");
  });

  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    search("normal");
  });
  $("hoppu-now").addEventListener("click", () => search("hoppu"));
  $("load-earlier").addEventListener("click", () => loadPage("earlier"));
  $("load-later").addEventListener("click", () => loadPage("later"));
  for (const radio of document.querySelectorAll('input[name="time-mode"]')) {
    radio.addEventListener("change", () => {
      $("time-hint").textContent =
        timeMode() === "arrive"
          ? "Arrive by needs a time. Hoppu! always leaves now."
          : "Empty time = now.";
    });
  }

  $("detail-back").addEventListener("click", () => history.back());
  // Help opens over the settings sheet; closing returns to it.
  const help = /** @type {HTMLDialogElement} */ ($("help"));
  $("open-help").addEventListener("click", () => {
    help.showModal();
    help.scrollTop = 0;
  });
  $("close-help").addEventListener("click", () => help.close());
  $("from-here").addEventListener("click", () => {
    fromField.set({ kind: "gps", name: "My location" });
    fromField.close();
  });
  window.addEventListener("popstate", (e) => {
    const d = e.state?.detail;
    const ride = e.state?.ride;
    if (typeof d !== "number") hideDetail();
    else if (typeof ride === "number") {
      // Forward into a ride: the detail is already there (or redraw it).
      if (d !== detailIndex || $("detail").hidden) showDetail(d);
      showRide(ride);
    } else if (rideView && d === detailIndex) {
      // Closing the sheet: the route's own transfer options come back.
      hideRide();
      const it = shown[d];
      for (const v of (it && transferViews.get(it)?.values()) ?? []) {
        if (v.status === "done") drawOptions(it, v);
      }
    } else showDetail(d);
  });
}

main();

// Offline startup (see sw.js). Only works over HTTPS or on localhost;
// elsewhere the app simply runs without it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => {
    console.warn("Service worker not registered:", e);
  });
}
