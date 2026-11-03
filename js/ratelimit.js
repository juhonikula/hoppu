// @ts-check
/** Client-side rate limiting, to stay well clear of Digitransit's limits. */

/**
 * Enforce a minimum interval between consecutive calls to wait().
 *
 * Unlike the Python version, callers here can overlap (two UI events firing
 * at once), so waits are queued on a promise chain: each caller's turn
 * starts only after the previous one finished. Without the queue, two
 * concurrent callers would both see the same "last request" time and fire
 * together.
 *
 * Clock and sleep are injectable so tests run on a fake clock.
 * performance.now() is monotonic, so wall-clock changes can't skew waits.
 */
export class Throttle {
  /** @type {number | null} */
  #last = null;
  /** @type {Promise<void>} */
  #queue = Promise.resolve();

  /**
   * @param {number} minIntervalMs
   * @param {{now?: () => number, sleep?: (ms: number) => Promise<void>}} [deps]
   */
  constructor(minIntervalMs, deps = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Resolves when it's this caller's turn to send a request. */
  wait() {
    const turn = this.#queue.then(() => this.#waitOne());
    // A failed turn must not block everyone queued behind it.
    this.#queue = turn.catch(() => {});
    return turn;
  }

  async #waitOne() {
    let now = this.now();
    if (this.#last !== null) {
      const remaining = this.#last + this.minIntervalMs - now;
      if (remaining > 0) {
        await this.sleep(remaining);
        now += remaining;
      }
    }
    this.#last = now;
  }
}
