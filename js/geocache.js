// @ts-check
/**
 * Geocoding results cached in the browser's localStorage, so repeat searches
 * ("Kamppi" every morning) cost no API calls.
 *
 * Entries never expire: place coordinates are effectively static.
 */

/** @typedef {import("./models.js").Place} Place */
/** @typedef {Pick<Storage, "getItem" | "setItem">} KeyValueStorage */

// Versioned so a future format change can start fresh instead of misreading.
const STORAGE_KEY = "hoppu.geocode.v1";

export class GeocodeCache {
  /** @param {KeyValueStorage} storage  localStorage, or a fake in tests */
  constructor(storage) {
    this.storage = storage;
    /** @type {Record<string, Place>} */
    this.entries = this.#load();
  }

  #load() {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      // Corrupt JSON, or storage blocked (some private modes): start empty.
      return {};
    }
  }

  /** "  kamppi " and "Kamppi" are the same search. @param {string} text */
  static key(text) {
    return text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  }

  /** @param {string} text @returns {Place | null} */
  get(text) {
    const e = this.entries[GeocodeCache.key(text)];
    return e ? { name: e.name, lat: e.lat, lon: e.lon } : null;
  }

  /** @param {string} text @param {Place} place */
  put(text, place) {
    this.entries[GeocodeCache.key(text)] = {
      name: place.name,
      lat: place.lat,
      lon: place.lon,
    };
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Quota full or storage blocked: keep the in-memory copy, it's a cache.
    }
  }
}
