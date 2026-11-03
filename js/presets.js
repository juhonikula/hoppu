// @ts-check
/** Named query settings: hoppu's defaults and the HSL app baseline. */

/** 8 km/h, the HSL app's fastest walking option. */
export const WALK_8_KMH = 8 / 3.6;

/**
 * What the HSL journey planner sends, used as the comparison baseline.
 * From digitransit-ui branch v3 (the deployed one; master is stale),
 * server/configs/config.default.js defaultSettings plus config.hsl.js
 * overrides; checked 2026-11-01. HSL doesn't enable the transfer time
 * selector, so users can't lower the 90 s. Walking speed is the app's
 * fastest option, since that's how a hurried user would set it there.
 */
export const HSL_APP_SETTINGS = Object.freeze({
  transferSlack: 90, // minTransferTime
  walkSpeed: WALK_8_KMH,
  walkReluctance: 1.8,
  boardCost: 120, // walkBoardCost
  transferCost: 180, // transferPenalty (HSL override)
});

/**
 * Normal-mode defaults: HSL's cost knobs and margin at an ordinary walking
 * pace, so a plain Search gives plans close to what the HSL app shows.
 */
export const NORMAL_PRESET = Object.freeze({
  ...HSL_APP_SETTINGS,
  walkSpeed: 5 / 3.6,
});

/**
 * Hoppu-mode defaults: the config from the 2026-11-02 rush-hour comparison
 * (ROADMAP): no margin, 8 km/h, walking not penalised, and a board cost of
 * 90 s as a tie-breaker (0 made OTP add pointless transfers).
 */
export const HOPPU_PRESET = Object.freeze({
  transferSlack: 0,
  walkSpeed: WALK_8_KMH,
  walkReluctance: 1,
  boardCost: 90,
  transferCost: null,
});
