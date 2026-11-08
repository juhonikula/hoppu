// @ts-check
/**
 * Speed units for the settings sheet: km/h, m/s, or pace (min:s per km).
 * Profiles always store km/h at full precision (settings.js); the unit only
 * changes how the walking and running speed fields read and are typed, so
 * switching units back and forth never drifts the stored value.
 *
 * Pace is the inverse of speed: seconds per km = 3600 / km/h. Phone number
 * pads often have no colon, so pace also accepts "." or "," as the
 * minute:second separator ("5,30" = 5:30 /km).
 */

/** @typedef {"kmh" | "mps" | "pace"} SpeedUnit */

/** @type {readonly SpeedUnit[]} */
export const SPEED_UNITS = Object.freeze(["kmh", "mps", "pace"]);

/** @type {Readonly<Record<SpeedUnit, string>>} */
export const UNIT_LABEL = Object.freeze({ kmh: "km/h", mps: "m/s", pace: "min/km" });

/** @param {unknown} u @returns {u is SpeedUnit} */
export const isSpeedUnit = (u) => SPEED_UNITS.includes(/** @type {SpeedUnit} */ (u));

/** Trailing zeros off: 8.50 -> "8.5", 8.00 -> "8". @param {number} n @param {number} digits */
const trim = (n, digits) => String(Number(n.toFixed(digits)));

/**
 * Seconds per km as "M:SS". @param {number} kmh @returns {string}
 */
export function formatPace(kmh) {
  const s = Math.round(3600 / kmh);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * "M:SS" typed as text to seconds: "2:10", "2.10" or "2,10" (number pads
 * often lack a colon; seconds need two digits, so "2.1" is still being
 * typed) or whole minutes ("2"). null when it doesn't parse.
 * @param {string} text @returns {number | null}
 */
export function parseMinSec(text) {
  const m = /^(\d{1,2})(?:[:.,](\d{2}))?$/.exec(text.trim());
  if (!m || Number(m[2] ?? 0) >= 60) return null;
  return Number(m[1]) * 60 + Number(m[2] ?? 0);
}

/**
 * A stored km/h value as the field shows it in `unit`.
 * @param {number} kmh @param {SpeedUnit} unit @returns {string}
 */
export function formatSpeed(kmh, unit) {
  if (unit === "mps") return trim(kmh / 3.6, 2);
  if (unit === "pace") return formatPace(kmh);
  return trim(kmh, 1);
}

/**
 * What the user typed, in `unit`, back to km/h; null when it isn't a
 * positive speed (empty, half-typed, zero).
 * Pace: as parseMinSec ("5:30", "5.30", "5,30", "6").
 * @param {string} text @param {SpeedUnit} unit @returns {number | null}
 */
export function parseSpeed(text, unit) {
  const t = text.trim();
  if (unit === "pace") {
    const sec = parseMinSec(t);
    return sec ? 3600 / sec : null;
  }
  // Finnish keyboards type a decimal comma.
  const n = Number(t.replace(",", "."));
  if (t === "" || !Number.isFinite(n) || n <= 0) return null;
  return unit === "mps" ? n * 3.6 : n;
}

/**
 * Input attributes for a speed field in `unit`, from its km/h range. In
 * pace the range flips: the fastest speed is the shortest pace. Pace is
 * typed as text (a number field can't hold "5:30").
 * @param {SpeedUnit} unit @param {{min: number, max: number}} kmh
 * @returns {{type: string, inputMode: string, step?: string, min?: string, max?: string, placeholder?: string}}
 */
export function speedInputAttrs(unit, kmh) {
  if (unit === "pace") {
    return { type: "text", inputMode: "decimal", placeholder: `${formatPace(kmh.max)}–${formatPace(kmh.min)}` };
  }
  if (unit === "mps") {
    return { type: "number", inputMode: "decimal", step: "0.05", min: trim(kmh.min / 3.6, 2), max: trim(kmh.max / 3.6, 2) };
  }
  return { type: "number", inputMode: "decimal", step: "0.5", min: String(kmh.min), max: String(kmh.max) };
}
