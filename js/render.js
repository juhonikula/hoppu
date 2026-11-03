// @ts-check
/**
 * Itinerary -> DOM. Pure rendering, no state and no API calls, so it can be
 * reused by the app and by test/preview pages. API strings go in as text
 * nodes, never innerHTML, so odd headsigns can't inject markup.
 *
 * Two views of an itinerary, modelled on the HSL app:
 * - summary card: times, a proportional colour bar, first boarding;
 * - timeline: vertical line in mode colours with a dot at every stop.
 */

import { compareArrivals, departureDelay, legDurationS, legSpans } from "./analysis.js";
import { durationS, isTransit } from "./models.js";
import { formatClock, formatMinSec, formatMinutes, formatSigned } from "./time.js";
import { LONG_WALK_M, classifyTransfer, findTransfers } from "./transfers.js";

/** @typedef {import("./models.js").Itinerary} Itinerary */
/** @typedef {import("./models.js").Leg} Leg */
/** @typedef {import("./transfers.js").Transfer} Transfer */
/** @typedef {import("./transfers.js").TransferOption} TransferOption */
/** @typedef {import("./transfers.js").Pace} Pace */
/** @typedef {import("./ride.js").Ride} Ride */
/** Walk/run estimate for a transfer (the app knows speeds and own times). @typedef {(t: Transfer) => Pace} PaceFor */

/**
 * Tiny element builder. Children that are strings become text nodes.
 * @param {string} tag
 * @param {string | null} [className]
 * @param {...(Node | string | null | false | undefined)} children
 */
export function h(tag, className, ...children) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const c of children) if (c) el.append(c);
  return el;
}

const MODE_LABEL = /** @type {Record<string, string>} */ ({
  WALK: "Walk",
  BUS: "Bus",
  TRAM: "Tram",
  SUBWAY: "Metro",
  RAIL: "Train",
  FERRY: "Ferry",
});

// Transfer kinds (transfers.js classifyTransfer) -> badge classes, styled
// in app.css: green with time to spare, amber under 2 min left after
// walking, red under 1 min, violet when only running makes it, greyed and
// struck through when even running is too slow.
const KIND_CLASS = { ok: "k-ok", snug: "k-snug", tight: "k-tight", run: "k-run", impossible: "k-impossible" };
// For picking a route's most critical transfer.
const KIND_RANK = { ok: 0, snug: 1, tight: 2, run: 3, impossible: 4 };

/**
 * "6:00 transfer", coloured by how it fits the user's pace. For the first
 * boarding the time runs from setting off: "6:00 to the stop".
 * @param {number} transferS @param {keyof KIND_CLASS} kind @param {boolean} [first]
 */
function transferBadge(transferS, kind, first = false) {
  const what = first ? "to the stop" : "transfer";
  const text = `${formatMinSec(transferS)} ${what}${kind === "impossible" ? " · too short" : ""}`;
  return h("span", `badge ${KIND_CLASS[kind]}`, text);
}

/**
 * Tiny stick-figure icon (12x12, currentColor) for the walk/run chip.
 * Built with createElementNS: SVG elements need their namespace.
 * @param {"walk" | "run"} which
 */
function figure(which) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const head = document.createElementNS(NS, "circle");
  const [hx, hy] = which === "walk" ? [6.5, 1.8] : [8, 1.8];
  head.setAttribute("cx", String(hx));
  head.setAttribute("cy", String(hy));
  head.setAttribute("r", "1.5");
  head.setAttribute("fill", "currentColor");
  const body = document.createElementNS(NS, "path");
  // Walking: upright, short stride. Running: leaning, wide stride, bent arm.
  body.setAttribute(
    "d",
    which === "walk"
      ? "M6.5 4L6 7.5M6.4 4.8L4.6 6.4M6.4 4.8L8.2 6.6M6 7.5L4.6 11M6 7.5L7.6 11"
      : "M7.4 4.2L5.8 7.4M7.2 4.6L9.6 5.6M7.2 4.6L4.8 4.6M5.8 7.4L8.4 8.6L7.6 11.2M5.8 7.4L3 8.8",
  );
  body.setAttribute("fill", "none");
  body.setAttribute("stroke", "currentColor");
  body.setAttribute("stroke-width", "1.4");
  body.setAttribute("stroke-linecap", "round");
  body.setAttribute("stroke-linejoin", "round");
  svg.append(head, body);
  return svg;
}

/**
 * Split chip "walk 3:25 | run 2:17" (icons, run half tinted purple), plus a
 * distance warning for long transfer walks. A saved own time shows as
 * "your time" instead of the walk estimate.
 * @param {Transfer} t @param {Pace} pace
 */
function paceChip(t, pace) {
  if (t.distanceM === 0 && !pace.own) return h("span", "pace same", t.first ? "at the stop" : "same stop");
  const chip = h(
    "span",
    "pace",
    h("span", "pace-walk", figure("walk"), pace.own ? `yours ${formatMinSec(pace.walkS)}` : formatMinSec(pace.walkS)),
    h("span", "pace-run", figure("run"), formatMinSec(pace.runS)),
  );
  chip.title = pace.own ? "Your saved time / running" : "Walking / running at your speeds";
  const long = t.distanceM >= LONG_WALK_M && h("span", "long-walk", `⚠ ${Math.round(t.distanceM)} m`);
  return h("span", null, chip, long);
}

/** @param {Leg} leg */
function liveBadge(leg) {
  const delay = departureDelay(leg);
  if (delay === null) return null;
  // Under 15 s is noise in the predictions; just show that it's live.
  if (Math.abs(delay) < 15) return h("span", "badge live", "live");
  // Amber: the realtime prediction differs from the timetable noticeably.
  return h("span", "badge snug", `${formatSigned(delay)} ${delay > 0 ? "late" : "early"}`);
}

/** Line badge ("M2" on metro orange); walking gets "Walk". @param {Leg} leg */
const modeBadge = (leg) =>
  h("span", `mode ${leg.mode}`, isTransit(leg) ? leg.line ?? MODE_LABEL[leg.mode] ?? leg.mode : "Walk");

/** Mark an element as standing for leg i (tap target). @param {HTMLElement} el @param {number} i */
const withLeg = (el, i) => {
  el.dataset.leg = String(i);
  return el;
};

// --- summary card -----------------------------------------------------------

/**
 * Proportional bar: each leg's width is its share of the trip time, waits
 * are empty track. Segments carry only the line ("560"); durations sit in a
 * separate row underneath with their unit ("8 min"), so "560 8" can't be
 * misread. Labels only where they fit; the thresholds are rough "fits on a
 * phone" guesses for a ~330 px bar.
 * @param {Itinerary} it
 */
export function renderBar(it) {
  const bar = h("div", "bar");
  const durations = h("div", "bar-durations");
  for (const { leg, left, width } of legSpans(it)) {
    const transit = isTransit(leg);
    const label = transit && width >= 0.07 ? leg.line ?? "" : "";
    const seg = h("span", `seg ${transit ? leg.mode : "WALK"}`, label && h("span", null, label));
    // The card opens the ride view when a vehicle's segment is tapped.
    if (transit) seg.dataset.leg = String(it.legs.indexOf(leg));
    seg.style.left = `${left * 100}%`;
    seg.style.width = `${width * 100}%`;
    bar.append(seg);
    // "8 min" needs ~40 px; centred under its segment.
    if (width >= 0.12) {
      const d = h("span", transit ? null : "walk", formatMinutes(legDurationS(leg)));
      d.style.left = `${(left + width / 2) * 100}%`;
      durations.append(d);
    }
  }
  const wrap = h("div", "bar-wrap", bar, durations);
  wrap.setAttribute("aria-hidden", "true"); // the card text says the same
  return wrap;
}

/**
 * One result in the list: a button that opens the detail view. With
 * onRide, tapping a vehicle (its bar segment or the first boarding's line
 * badge) opens that vehicle's ride view instead. The card stays one
 * button: the tap target is found from the click, not nested buttons.
 * @param {Itinerary} it @param {(it: Itinerary) => void} onOpen
 * @param {PaceFor} [paceFor]  to badge the route's most critical transfer
 * @param {(it: Itinerary, legIndex: number) => void} [onRide]
 */
export function renderSummary(it, onOpen, paceFor, onRide) {
  const transfers = `${it.numTransfers} transfer${it.numTransfers === 1 ? "" : "s"}`;
  const head = h(
    "span",
    "itinerary-head",
    h("span", "times", `${formatClock(it.start)} → ${formatClock(it.end)}`),
    h("span", "meta", `${formatMinutes(durationS(it))} · ${transfers}`),
  );

  // "Where do I have to be when": the first boarding, like the HSL app.
  const first = it.legs.find(isTransit);
  // The transfer most likely to go wrong (run > tight > snug > ok).
  let worst = null;
  for (const t of paceFor ? findTransfers(it) : []) {
    const T = (t.plannedDeparture.getTime() - t.arrival.getTime()) / 1000;
    const { kind } = classifyTransfer(T, /** @type {PaceFor} */ (paceFor)(t));
    if (!worst || KIND_RANK[kind] > KIND_RANK[worst.kind]) worst = { T, kind };
  }
  const sub = h(
    "span",
    "itinerary-sub",
    first
      ? h("span", null, withLeg(modeBadge(first), it.legs.indexOf(first)), `${formatClock(first.start)} from ${first.fromName}`)
      : h("span", null, `Walk ${Math.round(it.legs.reduce((a, l) => a + l.distanceM, 0))} m`),
    first && liveBadge(first),
    worst && transferBadge(worst.T, worst.kind),
  );

  const button = h("button", "itinerary-open", head, renderBar(it), sub);
  button.type = "button";
  button.addEventListener("click", (e) => {
    const vehicle = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest("[data-leg]"));
    if (vehicle && onRide) onRide(it, Number(vehicle.dataset.leg));
    else onOpen(it);
  });
  return h("li", "itinerary", button);
}

// --- timeline ---------------------------------------------------------------

/**
 * One row per leg, plus a final arrival row. Each row: clock time, a rail
 * cell (dot + line segment in the leg's colour, dotted for walking) and the
 * place name with what happens from there.
 * Each boarding after a transfer gets the transfer time (coloured by the
 * user's pace) and the walk/run chip on its own line.
 * @param {Itinerary} it
 * @param {{extra?: (legIndex: number) => Node | null, paceFor?: PaceFor,
 *   onRide?: (legIndex: number) => void, transfers?: Transfer[]}} [opts]
 *   extra: appended to a leg's row (the app puts the transfer box under
 *   each boarding); paceFor: walk/run estimate per transfer; onRide: the
 *   vehicle's line badge becomes a button opening its ride view;
 *   transfers: the boardings to badge (default: the changes, without the
 *   first boarding)
 */
export function renderTimeline(it, { extra = () => null, paceFor, onRide, transfers: list } = {}) {
  const transfers = new Map((list ?? findTransfers(it)).map((t) => [t.legIndex, t]));
  const rows = it.legs.map((leg, i) => {
    const transit = isTransit(leg);
    const duration = formatMinutes(legDurationS(leg));
    let badge = modeBadge(leg);
    if (transit && onRide) {
      badge = h("button", "mode-btn", badge);
      badge.setAttribute("type", "button");
      badge.setAttribute("aria-label", `Stops of ${leg.line ?? leg.mode}, get off elsewhere`);
      badge.addEventListener("click", () => onRide(i));
    }
    const what = transit
      ? h(
          "div",
          "tl-what",
          badge,
          `${MODE_LABEL[leg.mode] ?? leg.mode}${leg.headsign ? ` → ${leg.headsign}` : ""}`,
          h("span", "tl-dur", ` · ${duration}`),
          // Badges always on their own line, so they never wrap mid-text.
          h("div", "tl-badges", transferInfo(transfers.get(i), paceFor), liveBadge(leg)),
        )
      : h(
          "div",
          "tl-what",
          modeBadge(leg),
          h("span", "tl-dur", `${duration} · ${Math.round(leg.distanceM)} m`),
        );
    return h(
      "li",
      `tl-row ${transit ? leg.mode : "WALK"}`,
      h("span", "tl-time", formatClock(leg.start)),
      h("span", "tl-rail", h("span", "tl-dot")),
      h("div", "tl-body", h("div", "tl-place", leg.fromName), what, extra(i)),
    );
  });
  const last = it.legs.at(-1);
  if (last) {
    rows.push(
      h(
        "li",
        "tl-row end",
        h("span", "tl-time", formatClock(last.end)),
        h("span", "tl-rail", h("span", "tl-dot")),
        h("div", "tl-body", h("div", "tl-place", last.toName)),
      ),
    );
  }
  return rows;
}

/** Transfer badge + walk/run chip for a boarding, or null. @param {Transfer | undefined} t @param {PaceFor} [paceFor] */
function transferInfo(t, paceFor) {
  if (!t || !paceFor) return null;
  const pace = paceFor(t);
  const T = (t.plannedDeparture.getTime() - t.arrival.getTime()) / 1000;
  return h("span", null, transferBadge(T, classifyTransfer(T, pace).kind, t.first), paceChip(t, pace));
}

// --- transfer box -----------------------------------------------------------

/**
 * What the transfer box shows; the app owns it and re-renders on change.
 * @typedef {object} TransferView
 * @property {Transfer} transfer
 * @property {Pace} pace  walk/run estimate (or own time) for this transfer
 * @property {number | null} ownS  saved own time for this transfer
 * @property {"idle" | "loading" | "done" | "error"} status
 * @property {TransferOption[]} options
 * @property {string} [error]
 * @property {boolean} [ownOpen]  the "My time" editor is expanded
 * @property {Pace[]} [paces]  per option (each walks its own distance);
 *   falls back to `pace`
 * @property {string} [fromName]  where the options were planned from
 *   (transfers.js optionsOrigin)
 * @property {number} [keepLegs]  legs kept before an option's plan
 */

/** "−3′" / "+3′" for an arrival difference; null when the same. @param {number} s */
function delta(s) {
  const min = Math.round(s / 60);
  if (min === 0) return null;
  return h("span", `delta ${min < 0 ? "earlier" : "later"}`, `${min < 0 ? "−" : "+"}${Math.abs(min)}′`);
}

const KIND_LABEL = { earlier: "earlier", planned: "planned", later: "backup", alt: "" };

/**
 * Departure board for a transfer's options (dark, like a station board):
 * line, departure, transfer time coloured by pace, arrival and its
 * difference. Options too short even running stay, faded and struck
 * through, so the board always has the same rows (a delay can still make
 * them). Rows are buttons; tapping one follows that option.
 * @param {TransferView} v @param {(o: TransferOption) => void} onChoose
 */
export function renderOptionsBoard(v, onChoose) {
  const rows = [];
  v.options.forEach((o, i) => {
    if (o.walkOnly) {
      rows.push(boardRow(o, onChoose,
        h("span", "board-kind", o.kind === "planned" ? KIND_LABEL.planned : ""),
        modeBadge(o.leg),
        h("span", "board-time", `${(o.plan.legs.reduce((a, l) => a + l.distanceM, 0) / 1000).toFixed(1)} km`),
        h("span", "board-arrive", `→ ${formatClock(o.arrival)}`),
        delta(o.deltaS)));
      return;
    }
    const { kind } = classifyTransfer(o.changeS, v.paces?.[i] ?? v.pace);
    // Planned from elsewhere than the boarding station, an option may board
    // at another stop: show its own walk.
    const ownWalk = Math.round(o.walkM) !== Math.round(v.transfer.distanceM) && o.walkM > 0;
    const row = boardRow(o, onChoose,
      h("span", "board-kind", KIND_LABEL[o.kind]),
      modeBadge(o.leg),
      h("span", "board-time", formatClock(o.leg.start)),
      transferBadge(o.changeS, kind, v.transfer.first),
      ownWalk && h("span", "board-walk", `${Math.round(o.walkM)} m`),
      h("span", "board-arrive", `→ ${formatClock(o.arrival)}`),
      delta(o.deltaS));
    row.classList.toggle("too-short", kind === "impossible");
    rows.push(row);
  });
  return h("div", "board", ...rows);
}

/**
 * One tappable board row.
 * @param {TransferOption} o @param {(o: TransferOption) => void} onChoose
 * @param {...(Node | string | null | false | undefined)} cells
 */
function boardRow(o, onChoose, ...cells) {
  const b = h("button", `board-row ${o.kind}`, ...cells);
  b.setAttribute("type", "button");
  b.addEventListener("click", () => onChoose(o));
  return b;
}

/** Where a transfer's options were planned from, in words. @param {TransferView} v */
function originHint(v) {
  if (!v.fromName) return "";
  const at = formatClock(v.transfer.arrival);
  return v.transfer.first
    ? `From ${v.fromName} at ${at}. `
    : `From ${v.fromName}, where you get off, at ${at}. `;
}

/**
 * The box under a boarding: "Show options here" (one request), the
 * user's own time for this transfer behind a small toggle, and the
 * options board once loaded.
 * @param {TransferView} v
 * @param {{onShow: () => void, onSaveOwn: (seconds: number) => void, onClearOwn: () => void,
 *   onToggleOwn: () => void, onChoose: (o: TransferOption) => void}} on
 */
export function renderTransferBox(v, on) {
  const t = v.transfer;
  const show = h(
    "button",
    "secondary small",
    v.status === "loading" ? "Loading…" : v.status === "done" ? "Refresh options" : "Show options here",
  );
  show.setAttribute("type", "button");
  /** @type {HTMLButtonElement} */ (show).disabled = v.status === "loading" || !t.boardLocationId;
  show.addEventListener("click", on.onShow);

  // Own time for this alighting -> boarding station pair, in minutes. A
  // small toggle button; the editor only opens on request.
  /** @type {Node | null} */
  let ownToggle = null;
  /** @type {Node | null} */
  let ownEditor = null;
  if (t.key) {
    ownToggle = h(
      "button",
      `secondary small${v.ownS !== null ? " set" : ""}`,
      v.ownS !== null ? `My time: ${v.ownS / 60} min` : "My time…",
    );
    ownToggle.setAttribute("type", "button");
    ownToggle.setAttribute("aria-expanded", String(Boolean(v.ownOpen)));
    ownToggle.addEventListener("click", on.onToggleOwn);
  }
  if (t.key && v.ownOpen) {
    const input = /** @type {HTMLInputElement} */ (h("input", "own-input"));
    input.type = "number";
    input.min = "0";
    input.step = "0.5";
    input.inputMode = "decimal";
    input.placeholder = "min";
    input.setAttribute("aria-label", `My time from ${t.fromName} to ${t.toName}, minutes`);
    if (v.ownS !== null) input.value = String(v.ownS / 60);
    const save = h("button", "secondary small", "Save");
    save.setAttribute("type", "button");
    save.addEventListener("click", () => {
      const min = Number(input.value);
      if (input.value.trim() !== "" && Number.isFinite(min) && min >= 0) on.onSaveOwn(min * 60);
    });
    const clear = v.ownS !== null && h("button", "secondary small", "Clear");
    if (clear) {
      clear.setAttribute("type", "button");
      clear.addEventListener("click", on.onClearOwn);
    }
    ownEditor = h(
      "div",
      "own",
      h("span", "own-label", `${t.fromName} → ${t.toName}, minutes:`),
      input,
      save,
      clear,
    );
  }

  /** @type {Node | null} */
  let body = null;
  if (v.status === "error") body = h("p", "transfer-error", v.error ?? "Failed.");
  if (v.status === "done") {
    body = v.options.length
      ? h(
          "div",
          null,
          h(
            "p",
            "hint options-hint",
            originHint(v),
            "Tap an option to follow it.",
          ),
          renderOptionsBoard(v, on.onChoose),
        )
      : h("p", "transfer-error", "No departures found from this station.");
  }

  return h("div", "transfer", h("div", "transfer-actions", show, ownToggle), ownEditor, body);
}

// --- ride view ----------------------------------------------------------------

/**
 * Exit options loaded for one stop of the ride.
 * @typedef {object} StopView
 * @property {"loading" | "done" | "error"} status
 * @property {TransferOption[]} options
 * @property {Pace[]} paces  per option
 * @property {string} [error]
 */

/**
 * What the ride sheet shows; the app owns it.
 * @typedef {object} RideView
 * @property {Leg} leg
 * @property {"loading" | "done" | "error"} status  the trip request
 * @property {Ride | null} ride
 * @property {string} [error]
 * @property {import("./ride.js").RideProgress | null} progress  live
 *   position (rideProgress), null without a live vehicle
 * @property {Map<number, StopView>} stops  open exit boards by stop index
 */

/**
 * The ride sheet: header, then the stop list on the timeline's rail. The
 * vehicle sits as a pill between the stops it's travelling between (or
 * above your stop while it's still coming); passed stops are dimmed, the
 * track past the planned exit is thinner. Every stop not yet passed has
 * "Show options", which loads (on tap, one request) a board of exit
 * options under it; nothing is chosen until one is tapped.
 * @param {RideView} r
 * @param {{onClose: () => void, onRetry: () => void, onToggle: (i: number) => void,
 *   onChoose: (i: number, o: TransferOption) => void}} on
 */
export function renderRide(r, on) {
  const { leg } = r;
  const close = h("button", "icon-btn ride-close", "✕");
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", "Close stops");
  close.addEventListener("click", on.onClose);
  const last = r.ride?.stops.at(-1);
  const head = h(
    "div",
    "ride-head",
    modeBadge(leg),
    h("span", "ride-title", `${MODE_LABEL[leg.mode] ?? leg.mode} → ${last?.name ?? leg.headsign ?? leg.toName}`),
    h("span", "ride-sub", `from ${leg.fromName} ${formatClock(leg.start)}`),
    close,
  );
  if (r.status === "loading") return [h("div", "ride-grab"), head, h("p", "hint ride-msg", "Loading stops…")];
  if (r.status === "error" || !r.ride) {
    const retry = h("button", "secondary small", "Retry");
    retry.setAttribute("type", "button");
    retry.addEventListener("click", on.onRetry);
    return [h("div", "ride-grab"), head, h("p", "transfer-error ride-msg", r.error ?? "Stops not found.", " ", retry)];
  }
  const ride = r.ride;
  const p = r.progress;
  const after = p?.after ?? -1;
  // Standing at a stop (not yet left it) vs on the way to the next one.
  const moving = (p?.fraction ?? 0) > 0.05;
  const rows = [];
  if (p?.coming) {
    const { stopsAway, prev } = p.coming;
    const text = !prev
      ? "Coming: not yet left its first stop"
      : stopsAway === 1
        ? `Coming: at or after ${prev}, your stop is next`
        : `Coming: ${stopsAway} stops away, at or after ${prev}`;
    rows.push(nowRow(leg, text, "rs-coming"));
  }
  ride.stops.forEach((s, i) => {
    const passed = i < after || (i === after && moving);
    const cls = [
      "tl-row", leg.mode, "rs-row",
      passed && "passed",
      i > ride.exitIndex && "beyond",
      i === ride.exitIndex && "exit",
      i === ride.stops.length - 1 && "rs-last",
    ].filter(Boolean).join(" ");
    const tag =
      i === 0 ? h("span", "rs-tag", "you board")
        : i === ride.exitIndex ? h("span", "rs-tag exit", "planned exit") : null;
    const view = r.stops.get(i);
    let btn = null;
    if (i > 0 && !passed) {
      btn = h("button", "secondary small rs-btn",
        view?.status === "loading" ? "Loading…" : view ? "Hide" : "Show options");
      btn.setAttribute("type", "button");
      btn.addEventListener("click", () => on.onToggle(i));
    }
    let body = null;
    if (view?.status === "error") body = h("p", "transfer-error", view.error ?? "Failed.");
    if (view?.status === "done") {
      body = view.options.length
        ? renderOptionsBoard(
            /** @type {TransferView} */ ({
              transfer: /** @type {Transfer} */ ({ first: false, distanceM: 0 }),
              pace: view.paces[0],
              paces: view.paces,
              options: view.options,
            }),
            (o) => on.onChoose(i, o),
          )
        : h("p", "transfer-error", "Nothing from this stop.");
    }
    rows.push(
      h(
        "li",
        cls,
        h("span", "tl-time", formatClock(i === 0 ? s.departure : s.arrival)),
        h("span", "tl-rail", h("span", "tl-dot")),
        h("div", "tl-body", h("div", "rs-head", h("span", "tl-place", s.name), tag, btn), body),
      ),
    );
    if (p && i === after) {
      const next = ride.stops[i + 1];
      rows.push(nowRow(leg, moving && next ? `Between ${s.name} and ${next.name}` : `At ${s.name}`));
    }
  });
  return [h("div", "ride-grab"), head, h("ol", "timeline ride-stops", ...rows)];
}

/**
 * The vehicle's row in the stop list: "now", its line as a pill on the rail.
 * @param {Leg} leg @param {string} text @param {string} [extra]  class
 */
const nowRow = (leg, text, extra = "") =>
  h(
    "li",
    `tl-row ${leg.mode} rs-now ${extra}`,
    h("span", "tl-time", "now"),
    h("span", "tl-rail", h("span", "rs-pill", leg.line ?? "")),
    h("div", "tl-body", h("span", "rs-now-text", text)),
  );

/**
 * Chips for the versions of a route (the planner's, then each followed
 * option), with arrival times; the current one is highlighted. Hidden
 * (empty) with a single version.
 * @param {Itinerary[]} family @param {Itinerary} current
 * @param {(it: Itinerary) => void} onPick
 */
export function renderVersions(family, current, onPick) {
  if (family.length < 2) return [];
  return family.map((it, n) => {
    const b = h(
      "button",
      `secondary small version${it === current ? " on" : ""}`,
      `${n === 0 ? "Planned" : `#${n + 1}`} · ${formatClock(it.end)}`,
    );
    b.setAttribute("type", "button");
    b.setAttribute("aria-pressed", String(it === current));
    b.addEventListener("click", () => onPick(it));
    return b;
  });
}

/**
 * Fill the comparison banner; hides it when there is nothing to compare.
 * @param {HTMLElement} el @param {Itinerary[]} hoppu @param {Itinerary[] | null} baseline
 */
export function renderComparison(el, hoppu, baseline) {
  const c = baseline && compareArrivals(hoppu, baseline);
  el.hidden = !c;
  if (!c) return;
  const min = Math.round(c.savedS / 60);
  el.className = `comparison ${min > 0 ? "" : min < 0 ? "lost" : "same"}`;
  el.textContent =
    min > 0
      ? `${min} min earlier than the HSL app (${formatClock(c.baseline)}).`
      : min < 0
        ? `${-min} min later than the HSL app (${formatClock(c.baseline)}). Check your settings.`
        : `Same arrival as the HSL app (${formatClock(c.baseline)}).`;
}
