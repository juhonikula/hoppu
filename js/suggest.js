// @ts-check
/**
 * Suggestion dropdown for a place field (an ARIA combobox).
 *
 * Local suggestions (recents, stops; see places.js) render on every
 * keystroke for free. Only when nothing local matches does it ask the API
 * (addresses), after the user pauses typing (DEBOUNCE_MS) and only for
 * MIN_REMOTE_CHARS or more. When local hits exist, a "Search addresses"
 * row lets the user ask explicitly: one request, on tap.
 */

/** @typedef {import("./places.js").PlaceOption} PlaceOption */

const DEBOUNCE_MS = 400;
const MIN_REMOTE_CHARS = 3;
// After this long, the "Searching" row says the server is slow.
const SLOW_MS = 3_000;

/**
 * What the user picked: a place, or "use my GPS position".
 * @typedef {PlaceOption | {kind: "gps", name: string}} Picked
 */

/**
 * A row in the dropdown. Actions (my location, search addresses) are rows
 * too, so the keyboard handling treats everything the same way.
 * @typedef {{label: string, detail?: string, kind: string, run: () => void, place?: PlaceOption}} Row
 */

/**
 * Saving places from the dropdown: a star on every place row.
 * @typedef {object} StarOpts
 * @property {(p: PlaceOption) => boolean} isSaved
 * @property {(p: PlaceOption) => void} toggle  may prompt the user
 */

let nextId = 0;

export class PlaceInput {
  /**
   * @param {HTMLInputElement} input
   * @param {HTMLElement} list  the <ul role="listbox">
   * @param {object} opts
   * @param {(text: string) => PlaceOption[]} opts.local
   * @param {((text: string, signal: AbortSignal) => Promise<PlaceOption[]>) | null} opts.remote
   * @param {boolean} [opts.offerMyLocation]
   * @param {StarOpts | null} [opts.star]
   */
  constructor(input, list, { local, remote, offerMyLocation = false, star = null }) {
    this.input = input;
    this.list = list;
    this.local = local;
    this.remote = remote;
    this.offerMyLocation = offerMyLocation;
    this.star = star;
    /** @type {Picked | null} */
    this.picked = null;
    /** @type {Row[]} */
    this.rows = [];
    this.active = -1;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined;
    // Bumped on every keystroke; a remote answer for older text is dropped.
    this.generation = 0;
    /**
     * The address request in progress, aborted as soon as the text changes
     * or the list closes, so outdated requests never queue up behind the
     * throttle (the geocoder can take 10 s per request).
     * @type {AbortController | null}
     */
    this.pending = null;
    this.idPrefix = `opt${nextId++}-`;

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", list.id);

    input.addEventListener("focus", () => this.#update(false));
    input.addEventListener("input", () => {
      this.picked = null;
      this.#update(true);
    });
    input.addEventListener("keydown", (e) => this.#onKey(e));
    // Close when focus leaves; rows use pointerdown + preventDefault so a
    // tap on a row doesn't blur the input first.
    input.addEventListener("blur", () => this.close());
  }

  /** Set the field to a known place without opening the list. @param {Picked} p */
  set(p) {
    this.picked = p;
    this.input.value = p.name;
  }

  close() {
    clearTimeout(this.timer);
    this.#abortPending();
    this.list.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.active = -1;
  }

  #abortPending() {
    this.pending?.abort();
    this.pending = null;
  }

  /** @param {boolean} typed  true after a keystroke (may trigger the API) */
  #update(typed) {
    clearTimeout(this.timer);
    this.#abortPending();
    const gen = ++this.generation;
    const text = this.input.value.trim();
    const local = this.local(text);

    /** @type {Row[]} */
    const rows = [];
    if (this.offerMyLocation && !text) {
      rows.push({ label: "My location", detail: "Use GPS", kind: "gps",
                  run: () => this.#pick({ kind: "gps", name: "My location" }) });
    }
    for (const p of local) rows.push(this.#placeRow(p));

    const canRemote = this.remote !== null && text.length >= MIN_REMOTE_CHARS;
    if (canRemote && local.length === 0 && typed) {
      // Nothing local: probably an address. Ask once the user pauses.
      rows.push({ label: "Searching addresses…", kind: "info", run: () => {} });
      this.timer = setTimeout(() => this.#fetchRemote(text, gen, rows.slice(0, -1)), DEBOUNCE_MS);
    } else if (canRemote) {
      rows.push({ label: `Search addresses for “${text}”`, kind: "action",
                  run: () => this.#fetchRemote(text, gen, rows.slice(0, -1)) });
    }
    this.#render(rows);
  }

  /** @param {PlaceOption} p @returns {Row} */
  #placeRow(p) {
    const detail = p.kind === "recent" ? "Recent" : p.detail;
    return { label: p.name, detail, kind: p.kind, run: () => this.#pick(p), place: p };
  }

  /**
   * @param {string} text @param {number} gen
   * @param {Row[]} keep  rows to keep above the address results
   */
  async #fetchRemote(text, gen, keep) {
    if (!this.remote) return;
    this.#abortPending();
    const ctrl = new AbortController();
    this.pending = ctrl;
    this.#render([...keep, { label: "Searching addresses…", kind: "info", run: () => {} }]);
    const slow = setTimeout(() => {
      if (gen === this.generation && this.pending === ctrl) {
        this.#render([...keep, { label: "Searching addresses… (the server is slow)", kind: "info", run: () => {} }]);
      }
    }, SLOW_MS);
    let found;
    try {
      found = await this.remote(text, ctrl.signal);
    } catch (e) {
      // Cancelled because the text changed: the newer search takes over.
      if (ctrl.signal.aborted || gen !== this.generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.#render([
        ...keep,
        { label: "Address search failed. Retry", detail: msg, kind: "action",
          run: () => this.#fetchRemote(text, gen, keep) },
      ]);
      return;
    } finally {
      clearTimeout(slow);
      if (this.pending === ctrl) this.pending = null;
    }
    // The user kept typing meanwhile: this answer is for old text.
    if (gen !== this.generation) return;
    const rows = [...keep, ...found.map((p) => this.#placeRow(p))];
    if (!found.length) rows.push({ label: "No addresses found", kind: "info", run: () => {} });
    this.#render(rows);
  }

  /** @param {Row[]} rows */
  #render(rows) {
    this.rows = rows;
    this.active = -1;
    this.input.removeAttribute("aria-activedescendant");
    if (!rows.length || document.activeElement !== this.input) {
      this.close();
      return;
    }
    this.list.replaceChildren(
      ...rows.map((r, i) => {
        const li = document.createElement("li");
        li.id = this.idPrefix + i;
        li.className = `opt ${r.kind}`;
        li.setAttribute("role", "option");
        const label = document.createElement("span");
        label.className = "opt-label";
        label.textContent = r.label;
        li.append(label);
        if (r.detail) {
          const d = document.createElement("span");
          d.className = "opt-detail";
          d.textContent = r.detail;
          li.append(d);
        }
        if (r.kind === "info") li.setAttribute("aria-disabled", "true");
        const place = r.place;
        if (this.star && place) {
          const saved = this.star.isSaved(place);
          const star = document.createElement("button");
          star.type = "button";
          star.className = `star${saved ? " saved" : ""}`;
          star.textContent = saved ? "★" : "☆";
          star.tabIndex = -1; // keyboard users have the settings list
          star.setAttribute("aria-label", saved ? `Remove ${r.label} from saved places` : `Save ${r.label}`);
          star.addEventListener("pointerdown", (e) => {
            // Don't pick the row underneath, and keep focus where it is.
            e.preventDefault();
            e.stopPropagation();
            /** @type {StarOpts} */ (this.star).toggle(place);
            this.#update(false);
          });
          li.append(star);
        }
        li.addEventListener("pointerdown", (e) => {
          e.preventDefault(); // keep focus in the input
          if (r.kind !== "info") r.run();
        });
        return li;
      }),
    );
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
  }

  /** @param {Picked} p */
  #pick(p) {
    this.set(p);
    this.close();
  }

  /** @param {KeyboardEvent} e */
  #onKey(e) {
    if (this.list.hidden) {
      if (e.key === "ArrowDown") this.#update(false);
      return;
    }
    const selectable = this.rows.map((r, i) => (r.kind === "info" ? -1 : i)).filter((i) => i >= 0);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!selectable.length) return;
      const pos = selectable.indexOf(this.active);
      const next =
        e.key === "ArrowDown"
          ? selectable[(pos + 1) % selectable.length]
          : selectable[(pos - 1 + selectable.length) % selectable.length];
      this.#setActive(next);
    } else if (e.key === "Enter" && this.active >= 0) {
      // Pick the highlighted row instead of submitting the form.
      e.preventDefault();
      this.rows[this.active].run();
    } else if (e.key === "Escape") {
      this.close();
    }
  }

  /** @param {number} i */
  #setActive(i) {
    this.active = i;
    for (const [j, li] of [...this.list.children].entries()) {
      li.classList.toggle("active", j === i);
      li.setAttribute("aria-selected", String(j === i));
    }
    this.input.setAttribute("aria-activedescendant", this.idPrefix + i);
    this.list.children[i]?.scrollIntoView({ block: "nearest" });
  }
}
