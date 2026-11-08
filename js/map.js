// @ts-check
/**
 * Route map for the detail view, drawn with Leaflet on OpenStreetMap tiles.
 *
 * Leaflet is vendored (web/vendor/leaflet) and loaded as a classic script
 * before the app modules, so it is the global `L`. OSM tiles only come in a
 * light style; CSS (.map .leaflet-tile-pane in app.css) inverts them into a
 * dark map, while the route lines on their own pane keep their colours.
 * Tiles are fetched by the browser from tile.openstreetmap.org; they never
 * go through the Digitransit throttle, and the service worker ignores them.
 */

import { isTransit } from "./models.js";

/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./hfp.js").Vehicle} Vehicle */

// HFP topic modes -> the CSS colour tokens used for legs.
const HFP_MODE = /** @type {Record<string, string>} */ ({
  bus: "BUS", tram: "TRAM", metro: "SUBWAY", train: "RAIL", ferry: "FERRY", ubus: "BUS", robot: "BUS",
});

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
// OSM's tile policy requires visible attribution with a copyright link.
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

/** Previous routes: grey, solid (dashed means "option"). */
const GHOST = "#9aa4b2";
// A previous route counts as "on the current route" within this distance.
const SHARED_M = 30;

/** Metres from point p to segment a-b, flat (fine at city scale). */
function segmentDistance(/** @type {[number, number]} */ p, /** @type {[number, number]} */ a, /** @type {[number, number]} */ b) {
  const kx = 111_320 * Math.cos(a[0] * (Math.PI / 180));
  const [bx, by] = [(b[1] - a[1]) * kx, (b[0] - a[0]) * 110_574];
  const [px, py] = [(p[1] - a[1]) * kx, (p[0] - a[0]) * 110_574];
  const len2 = bx * bx + by * by;
  const f = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - f * bx, py - f * by);
}

/**
 * The stretches of `ghost` that leave `current` (more than SHARED_M from
 * it), as point runs of at least two points; each run starts and ends at
 * the shared point next to it, so it visibly branches off the route.
 * Shared track is left out: drawn, it would only stripe the route itself.
 * @param {Itinerary} ghost @param {Itinerary} current
 * @returns {[number, number][][]}
 */
export function divergentParts(ghost, current) {
  const segs = current.legs.flatMap((l) => l.geometry.slice(1).map((q, i) => [l.geometry[i], q]));
  const far = (/** @type {[number, number]} */ p) => segs.every(([a, b]) => segmentDistance(p, a, b) > SHARED_M);
  /** @type {[number, number][][]} */
  const out = [];
  for (const leg of ghost.legs) {
    /** @type {[number, number][]} */
    let run = [];
    leg.geometry.forEach((p, i) => {
      if (far(p)) {
        if (!run.length && i > 0) run.push(leg.geometry[i - 1]);
        run.push(p);
      } else if (run.length) {
        run.push(p);
        out.push(run);
        run = [];
      }
    });
    if (run.length > 1) out.push(run);
  }
  return out;
}

/** Mode colours come from the CSS tokens, so map and timeline always agree. */
function modeColor(/** @type {string} */ mode) {
  const css = getComputedStyle(document.documentElement);
  const name = { BUS: "--bus", TRAM: "--tram", SUBWAY: "--subway", RAIL: "--rail", FERRY: "--ferry" }[mode];
  return css.getPropertyValue(name ?? "--bus").trim() || "#007ac9";
}

export class RouteMap {
  /**
   * @param {HTMLElement} el  must be visible when show() is called
   * @param {object} [options]  extra Leaflet map options (the screenshot
   *   harness turns off the tile fade-in, which headless shots catch midway)
   */
  constructor(el, options = {}) {
    this.el = el;
    this.options = options;
    /** @type {any} */
    this.map = null;
    /** @type {any} */
    this.layer = null;
    /**
     * Live vehicle markers by vehicle id, with the arrow element to turn.
     * @type {Map<string, {marker: any, arrow: HTMLElement}>}
     */
    this.vehicles = new Map();
    /** Transfer options drawn on top of the route. @type {any} */
    this.optionLayer = null;
    /** Previous versions of the route. @type {any} */
    this.ghostLayer = null;
    /** The open ride's stops and track past the planned exit. @type {any} */
    this.rideLayer = null;
    /** Tap on a vehicle marker. @type {((v: Vehicle) => void) | null} */
    this.onVehicle = null;
    /** Latest data per marker, for the tap handler. @type {Map<string, Vehicle>} */
    this.vehicleData = new Map();
  }

  /**
   * Previous versions of the route, grey and solid, only where they leave
   * the current one (see divergentParts); drawn above the route so they
   * stay tappable. Each run gets a wide invisible twin for fingers.
   * @param {{it: Itinerary, onTap: () => void}[]} ghosts @param {Itinerary} current
   */
  showGhosts(ghosts, current) {
    if (!this.map) return;
    const L = /** @type {any} */ (globalThis).L;
    this.ghostLayer?.remove();
    // Above overlayPane (400), below markers (600).
    if (!this.map.getPane("ghosts")) this.map.createPane("ghosts").style.zIndex = "410";
    this.ghostLayer = L.layerGroup().addTo(this.map);
    for (const g of ghosts) {
      for (const run of divergentParts(g.it, current)) {
        L.polyline(run, { color: GHOST, weight: 4, opacity: 0.85, pane: "ghosts", interactive: false })
          .addTo(this.ghostLayer);
        L.polyline(run, { weight: 20, opacity: 0, pane: "ghosts" }).addTo(this.ghostLayer).on("click", g.onTap);
      }
    }
  }

  /**
   * The ride view's extras: the track past the planned exit (faint) and
   * every stop as a tappable dot.
   * @param {import("./ride.js").Ride} ride @param {string} mode
   * @param {[number, number][]} beyond  shape from the planned exit to the end
   * @param {(i: number) => void} onStop
   */
  showRide(ride, mode, beyond, onStop) {
    if (!this.map) return;
    const L = /** @type {any} */ (globalThis).L;
    this.clearRide();
    this.rideLayer = L.layerGroup().addTo(this.map);
    const color = modeColor(mode);
    if (beyond.length > 1) L.polyline(beyond, { color, weight: 4, opacity: 0.45 }).addTo(this.rideLayer);
    ride.stops.forEach((s, i) => {
      L.circleMarker([s.lat, s.lon], { radius: 5, color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
        .addTo(this.rideLayer)
        .bindTooltip(s.name)
        .on("click", () => onStop(i));
    });
  }

  clearRide() {
    this.rideLayer?.remove();
    this.rideLayer = null;
  }

  /**
   * Zoom to points, keeping them out of the bottom `bottomPx` (covered by
   * the ride sheet).
   * @param {[number, number][]} points @param {number} [bottomPx]
   */
  fit(points, bottomPx = 0) {
    if (!this.map || !points.length) return;
    const L = /** @type {any} */ (globalThis).L;
    this.map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [28, 28],
      paddingBottomRight: [28, 28 + bottomPx],
      animate: false, // a jump; the sheet just slid up anyway
    });
  }

  /**
   * Draw a transfer's options as faded dashed lines in their line colours
   * (tap one to choose it). The departure board stays in the list below
   * the map: on a phone map it covers too much of the route.
   * @param {import("./transfers.js").TransferOption[]} options
   * @param {(o: import("./transfers.js").TransferOption) => void} onChoose
   */
  showOptions(options, onChoose) {
    if (!this.map) return;
    this.clearOptions();
    if (!options.length) return;
    const L = /** @type {any} */ (globalThis).L;
    this.optionLayer = L.layerGroup().addTo(this.map);
    for (const o of options) {
      for (const leg of o.plan.legs.filter(isTransit)) {
        if (leg.geometry.length < 2) continue;
        L.polyline(leg.geometry, { color: modeColor(leg.mode), weight: 5, opacity: 0.55, dashArray: "8 7" })
          .addTo(this.optionLayer)
          .on("click", () => onChoose(o));
      }
    }
  }

  clearOptions() {
    this.optionLayer?.remove();
    this.optionLayer = null;
  }

  /** Leaflet missing (script failed to load): degrade to no map. */
  get available() {
    return typeof (/** @type {any} */ (globalThis).L) !== "undefined";
  }

  #init() {
    const L = /** @type {any} */ (globalThis).L;
    this.map = L.map(this.el, { zoomControl: false, ...this.options });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(this.map);
    // Leaflet's default prefix links to Leaflet with a flag icon; keep
    // just a plain link to save space on phones.
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  }

  /**
   * Show live vehicles: move existing markers, add new ones, drop the rest.
   * A marker is a pill with the line name in its mode colour, plus an
   * arrow orbiting it that points where the vehicle is heading.
   * @param {Vehicle[]} list
   */
  setVehicles(list) {
    if (!this.map) return;
    const L = /** @type {any} */ (globalThis).L;
    const keep = new Set();
    for (const v of list) {
      keep.add(v.id);
      this.vehicleData.set(v.id, v);
      let entry = this.vehicles.get(v.id);
      if (!entry) {
        const color = modeColor(HFP_MODE[v.mode] ?? "BUS");
        const pill = document.createElement("span");
        pill.className = "vehicle";
        pill.textContent = v.line;
        pill.style.background = color;
        const arrow = document.createElement("span");
        arrow.className = "vehicle-arrow";
        arrow.style.borderBottomColor = color;
        const wrap = document.createElement("span");
        wrap.className = "vehicle-wrap";
        wrap.append(arrow, pill);
        // Anchor 0,0 + CSS centring: the wrapper's centre is the position.
        const marker = L.marker([v.lat, v.lon], {
          icon: L.divIcon({ className: "", html: wrap, iconSize: null, iconAnchor: [0, 0] }),
          keyboard: false,
          zIndexOffset: 500, // above stop dots
        });
        marker.addTo(this.map);
        marker.on("click", () => {
          const data = this.vehicleData.get(v.id);
          if (data) this.onVehicle?.(data);
        });
        entry = { marker, arrow };
        this.vehicles.set(v.id, entry);
      } else {
        entry.marker.setLatLng([v.lat, v.lon]);
      }
      // HFP heading: degrees clockwise from north; none = no arrow.
      entry.arrow.hidden = v.heading === null;
      entry.arrow.style.setProperty("--heading", `${v.heading ?? 0}deg`);
    }
    for (const [id, e] of this.vehicles) {
      if (!keep.has(id)) {
        e.marker.remove();
        this.vehicles.delete(id);
        this.vehicleData.delete(id);
      }
    }
  }

  /**
   * Draw an itinerary and zoom to it. Tapping a vehicle leg's line calls
   * onLeg with its index (the app opens the ride view).
   * @param {Itinerary} it @param {{onLeg?: (legIndex: number) => void}} [opts]
   */
  show(it, { onLeg } = {}) {
    if (!this.available) {
      this.el.textContent = "Map unavailable (Leaflet didn't load).";
      return;
    }
    const L = /** @type {any} */ (globalThis).L;
    if (!this.map) this.#init();
    // The container may have been hidden while the window resized.
    this.map.invalidateSize();
    this.layer?.remove();
    this.clearOptions();
    this.clearRide();
    this.ghostLayer?.remove();
    this.ghostLayer = null;
    this.layer = L.layerGroup().addTo(this.map);

    /** @type {[number, number][]} */
    const all = [];
    it.legs.forEach((leg, i) => {
      const g = leg.geometry;
      if (g.length < 2) return;
      all.push(...g);
      if (isTransit(leg)) {
        const color = modeColor(leg.mode);
        // Dark casing under the coloured line keeps it readable on any tile.
        L.polyline(g, { color: "#000", weight: 9, opacity: 0.45 }).addTo(this.layer);
        const line = L.polyline(g, { color, weight: 6, opacity: 1 }).addTo(this.layer);
        if (onLeg) line.on("click", () => onLeg(i));
        // Boarding and alighting stops: white dots ringed in the line colour.
        for (const p of [g[0], g[g.length - 1]]) {
          L.circleMarker(p, { radius: 5, color, weight: 3, fillColor: "#fff", fillOpacity: 1 })
            .addTo(this.layer);
        }
      } else {
        // Walking: dotted grey, like the timeline.
        L.polyline(g, { color: "#c3c9d2", weight: 4, dashArray: "1 8", lineCap: "round" })
          .addTo(this.layer);
      }
    });
    if (!all.length) return;

    // Origin: hollow ring; destination: filled dot.
    L.circleMarker(all[0], { radius: 7, color: "#fff", weight: 3, fillColor: "#141821", fillOpacity: 1 })
      .addTo(this.layer);
    L.circleMarker(all[all.length - 1], { radius: 8, color: "#141821", weight: 3, fillColor: "#fff", fillOpacity: 1 })
      .addTo(this.layer);
    this.map.fitBounds(L.latLngBounds(all), { padding: [28, 28] });
  }
}
