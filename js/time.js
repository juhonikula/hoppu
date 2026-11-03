// @ts-check
/**
 * Helsinki time helpers. The phone may be set to any timezone, but HSL
 * timetables are Helsinki wall-clock time, so all display and input goes
 * through Europe/Helsinki explicitly.
 */

export const TZ = "Europe/Helsinki";

const clockFmt = new Intl.DateTimeFormat("fi-FI", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "07:35" in Helsinki time. @param {Date} d */
export const formatClock = (d) => clockFmt.format(d).replace(".", ":");

/** Seconds -> "+1:46" / "-0:20". @param {number} s */
export function formatSigned(s) {
  const sign = s < 0 ? "-" : "+";
  const abs = Math.round(Math.abs(s));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** Helsinki UTC offset in ms at instant t. @param {number} t epoch ms */
function helsinkiOffsetMs(t) {
  const p = Object.fromEntries(partsFmt.formatToParts(t).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * Helsinki wall-clock date + time -> instant, without a date library.
 * Guess the instant as if Helsinki were UTC, then subtract Helsinki's offset
 * at that guess. A second pass fixes guesses that land on the other side of
 * a DST switch.
 *
 * @param {string} date "2026-11-02" @param {string} time "07:35"
 */
export function helsinkiToDate(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - helsinkiOffsetMs(wall);
  t = wall - helsinkiOffsetMs(t);
  return new Date(t);
}

/** Today's date in Helsinki as "YYYY-MM-DD". @param {Date} [now] */
export function helsinkiToday(now = new Date()) {
  // sv-SE formats dates as ISO YYYY-MM-DD.
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(now);
}

/** Seconds -> "13 min", "1 h 05 min"; under half a minute "<1 min". @param {number} s */
export function formatMinutes(s) {
  const min = Math.round(s / 60);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/** Seconds -> "4:27" (no sign; negative counts as 0). @param {number} s */
export function formatMinSec(s) {
  const abs = Math.max(0, Math.round(s));
  return `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}
