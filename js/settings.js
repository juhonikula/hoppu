// @ts-check
/**
 * User settings: two search profiles, Normal (Search button) and Hoppu
 * ("Hoppu!"), in the units the settings sheet shows (minutes, km/h).
 * Storage is injected, so tests run against a Map.
 */

import { HOPPU_PRESET, NORMAL_PRESET } from "./presets.js";
import { isSpeedUnit } from "./units.js";

/** @typedef {Pick<Storage, "getItem" | "setItem">} KeyValueStorage */
/** @typedef {"normal" | "hoppu"} ProfileName */

/**
 * null = leave it to the router's default.
 * @typedef {object} Profile
 * @property {number} slackMin  transfer margin for the search, minutes, >= 0
 *   (added to the planner's walk)
 * @property {number} walkKmh  max walking speed; also judges transfers
 * @property {number} runKmh  max running speed: transfers only reachable
 *   between the two show as "run" (transfers.js)
 * @property {number | null} walkReluctance
 * @property {number | null} boardCost  seconds
 * @property {number | null} transferCost  seconds
 * @property {number} numResults
 * @property {boolean} compare  also query the HSL app settings (1 extra request)
 */

/**
 * speedUnit: how the sheet shows walking and running speed, for both
 * profiles (profiles always store km/h; units.js).
 * @typedef {{normal: Profile, hoppu: Profile, speedUnit: import("./units.js").SpeedUnit}} Settings
 */

const SETTINGS_KEY = "hoppu.settings.v2";
const V1_KEY = "hoppu.settings.v1";

/**
 * Query-unit preset -> UI-unit profile. Running speed is hoppu's own (the
 * planner has no such thing), so it comes separately.
 * @param {typeof HOPPU_PRESET} p @param {number} runKmh @returns {Profile}
 */
const fromPreset = (p, runKmh) => ({
  slackMin: (p.transferSlack ?? 0) / 60,
  walkKmh: Math.round((p.walkSpeed ?? 0) * 3.6 * 10) / 10,
  runKmh,
  walkReluctance: p.walkReluctance,
  boardCost: p.boardCost,
  transferCost: p.transferCost,
  numResults: 3,
  compare: false,
});

export const PROFILE_DEFAULTS = Object.freeze({
  // Running: a jog for normal, a proper run when in a hurry.
  normal: Object.freeze(fromPreset(NORMAL_PRESET, 10)),
  hoppu: Object.freeze(fromPreset(HOPPU_PRESET, 12)),
});

/** @returns {Settings} */
const defaults = () => ({
  normal: { ...PROFILE_DEFAULTS.normal },
  hoppu: { ...PROFILE_DEFAULTS.hoppu },
  speedUnit: /** @type {import("./units.js").SpeedUnit} */ ("kmh"),
});

// What v1 (one profile) shipped with. Only values the user changed from
// these are carried over, so untouched installs get the new defaults.
const V1_DEFAULTS = /** @type {Record<string, unknown>} */ ({
  slackMin: 0,
  walkKmh: 8,
  walkReluctance: null,
  boardCost: null,
  transferCost: null,
  numResults: 3,
});

/**
 * v1 had one profile, used for every search; its customised values become
 * the Hoppu profile, since v1 was hoppu-style (0 margin, 8 km/h).
 * @param {Record<string, unknown>} v1 @returns {Settings}
 */
export function migrateV1(v1) {
  const s = defaults();
  for (const [k, def] of Object.entries(V1_DEFAULTS)) {
    if (k in v1 && v1[k] !== def) /** @type {any} */ (s.hoppu)[k] = v1[k];
  }
  return s;
}

/** @param {KeyValueStorage} storage @returns {Settings} */
export function loadSettings(storage) {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Merge per profile, so a field added later gets its default.
      // Negative margins existed briefly (2026-11-02); "run" options replace
      // them, so they become 0.
      const merge = (/** @type {ProfileName} */ n) => {
        const p = { ...PROFILE_DEFAULTS[n], ...saved[n] };
        return { ...p, slackMin: Math.max(0, p.slackMin) };
      };
      return {
        normal: merge("normal"),
        hoppu: merge("hoppu"),
        speedUnit: isSpeedUnit(saved.speedUnit) ? saved.speedUnit : "kmh",
      };
    }
    const v1 = storage.getItem(V1_KEY);
    if (v1) return migrateV1(JSON.parse(v1));
  } catch {
    // Corrupt JSON or blocked storage: defaults.
  }
  return defaults();
}

/** @param {KeyValueStorage} storage @param {Settings} s */
export function saveSettings(storage, s) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Quota or blocked storage: settings just won't persist.
  }
}

/**
 * Profile -> the RouteQuery fields it controls.
 * @param {Profile} p
 */
export const profileToQuery = (p) => ({
  // OTP only takes slack >= 0 (old saved negatives are clamped on load).
  transferSlack: Math.max(0, p.slackMin * 60),
  walkSpeed: p.walkKmh / 3.6,
  walkReluctance: p.walkReluctance,
  boardCost: p.boardCost,
  transferCost: p.transferCost,
  numResults: p.numResults,
});
