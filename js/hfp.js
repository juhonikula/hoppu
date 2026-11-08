// @ts-check
/**
 * Live vehicle positions from HSL's high-frequency positioning feed (HFP),
 * published over MQTT at wss://mqtt.hsl.fi. Open data, no key, and not a
 * Digitransit API call, so it doesn't count against the request budget.
 * https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/
 *
 * MQTT needs a client library normally; hoppu only ever subscribes with
 * QoS 0, which needs a handful of packet types, so this file implements
 * that subset of MQTT 3.1.1 directly over a WebSocket:
 *   CONNECT -> CONNACK, SUBSCRIBE -> SUBACK, PUBLISH (incoming, QoS 0),
 *   UNSUBSCRIBE, PINGREQ/PINGRESP keepalive, DISCONNECT.
 * Packet encoding/decoding are pure functions (tested in Node); the
 * HfpClient class is the WebSocket glue.
 *
 * MQTT packet layout: 1 byte type+flags, then the "remaining length" as a
 * varint (7 bits per byte, high bit = more), then the packet body.
 * Strings are a 2-byte big-endian length followed by UTF-8 bytes.
 */

export const HFP_URL = "wss://mqtt.hsl.fi:443/";

const te = new TextEncoder();
const td = new TextDecoder();

/** MQTT string: 2-byte length + UTF-8. @param {string} s */
function mqttString(s) {
  const b = te.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

/** Remaining-length varint. @param {number} n */
function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

/** @param {number} header @param {number[]} body */
const packet = (header, body) => new Uint8Array([header, ...encodeLength(body.length), ...body]);

/** CONNECT with a clean session. @param {string} clientId @param {number} keepAliveS */
export function encodeConnect(clientId, keepAliveS = 60) {
  return packet(0x10, [
    ...mqttString("MQTT"),
    4, // protocol level 4 = MQTT 3.1.1
    0x02, // flags: clean session, no will/user/password
    keepAliveS >> 8,
    keepAliveS & 0xff,
    ...mqttString(clientId),
  ]);
}

/** SUBSCRIBE to topic filters at QoS 0. @param {number} id @param {string[]} topics */
export function encodeSubscribe(id, topics) {
  // 0x82: SUBSCRIBE requires flags 0b0010.
  return packet(0x82, [id >> 8, id & 0xff, ...topics.flatMap((t) => [...mqttString(t), 0])]);
}

/** @param {number} id @param {string[]} topics */
export function encodeUnsubscribe(id, topics) {
  return packet(0xa2, [id >> 8, id & 0xff, ...topics.flatMap(mqttString)]);
}

export const PINGREQ = new Uint8Array([0xc0, 0]);
export const DISCONNECT = new Uint8Array([0xe0, 0]);

/**
 * @typedef {{type: number, body: Uint8Array}} RawPacket  type = high nibble
 */

/**
 * Split a byte buffer into complete packets. WebSocket messages may carry
 * several MQTT packets or (in theory) part of one, so the unparsed tail is
 * returned to prepend to the next message.
 * @param {Uint8Array} buf @returns {{packets: RawPacket[], rest: Uint8Array}}
 */
export function decodePackets(buf) {
  /** @type {RawPacket[]} */
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    let len = 0;
    let mult = 1;
    let j = i + 1;
    let byte;
    do {
      if (j >= buf.length) return { packets, rest: buf.slice(i) }; // length incomplete
      byte = buf[j++];
      len += (byte & 0x7f) * mult;
      mult *= 128;
    } while (byte & 0x80);
    if (j + len > buf.length) return { packets, rest: buf.slice(i) }; // body incomplete
    packets.push({ type: buf[i] >> 4, body: buf.slice(j, j + len) });
    i = j + len;
  }
  return { packets, rest: new Uint8Array(0) };
}

/**
 * Topic and payload of a QoS 0 PUBLISH body.
 * @param {Uint8Array} body @returns {{topic: string, payload: string}}
 */
export function decodePublish(body) {
  const n = (body[0] << 8) | body[1];
  return { topic: td.decode(body.slice(2, 2 + n)), payload: td.decode(body.slice(2 + n)) };
}

/**
 * Topic filter for one route's vehicle positions, optionally one direction.
 * HFP v2 topic: /hfp/v2/journey/ongoing/vp/<mode>/<operator>/<vehicle>/
 *   <route_id>/<direction 1|2>/<headsign>/<start>/<next_stop>/<geohash...>
 * route_id is the GTFS route id without the "HSL:" feed prefix.
 * @param {string} gtfsRouteId  e.g. "HSL:31M2" @param {number | null} directionId  GTFS 0/1
 */
export function routeTopic(gtfsRouteId, directionId) {
  const route = gtfsRouteId.replace(/^HSL:/, "");
  const dir = directionId === null ? "+" : String(directionId + 1);
  return `/hfp/v2/journey/ongoing/vp/+/+/+/${route}/${dir}/#`;
}

/**
 * Topic filter for one specific trip: route, direction and the trip's start
 * time ("HH:MM", topic level 11) single out the vehicle running it, so the
 * map shows the bus you'd take, not every bus of the line. Falls back to
 * the whole route (one direction) when the start time is unknown.
 * @param {string} gtfsRouteId @param {number | null} directionId @param {string | null} start
 */
export function tripTopic(gtfsRouteId, directionId, start) {
  if (!start || directionId === null) return routeTopic(gtfsRouteId, directionId);
  const route = gtfsRouteId.replace(/^HSL:/, "");
  return `/hfp/v2/journey/ongoing/vp/+/+/+/${route}/${directionId + 1}/+/${start}/#`;
}

/**
 * A vehicle position from a "vp" message.
 * @typedef {object} Vehicle
 * @property {string} id  operator/vehicle, unique per vehicle
 * @property {string} line  e.g. "M2", "560"
 * @property {string} mode  bus, tram, metro, train, ferry (from the topic)
 * @property {number} lat
 * @property {number} lon
 * @property {number | null} heading  degrees
 * @property {number} at  epoch ms of the position
 * @property {string} trip  "route/direction/start" from the topic, e.g.
 *   "3002A/1/21:23"; matches legTripKey of the leg it runs
 */

/** @param {string} topic @param {string} payload @returns {Vehicle | null} */
export function parseVehicle(topic, payload) {
  const parts = topic.split("/");
  // ["", "hfp", "v2", "journey", "ongoing", "vp", mode, oper, veh, route, ...]
  if (parts[5] !== "vp") return null;
  let vp;
  try {
    vp = JSON.parse(payload).VP;
  } catch {
    return null;
  }
  // Vehicles without a GPS fix send nulls.
  if (!vp || typeof vp.lat !== "number" || typeof vp.long !== "number") return null;
  return {
    id: `${parts[7]}/${parts[8]}`,
    line: String(vp.desi ?? parts[9]),
    mode: parts[6],
    lat: vp.lat,
    lon: vp.long,
    heading: typeof vp.hdg === "number" ? vp.hdg : null,
    at: vp.tsi ? vp.tsi * 1000 : Date.now(),
    // Topic: .../route/direction(1|2)/headsign/start/...
    trip: `${parts[9]}/${parts[10]}/${parts[12]}`,
  };
}

/**
 * The same key as Vehicle.trip for an itinerary leg, to find the vehicle
 * running it; null for walks or legs without trip details.
 * @param {import("./models.js").Leg} leg @returns {string | null}
 */
export function legTripKey(leg) {
  if (!leg.routeId || leg.directionId === null || !leg.tripStart) return null;
  return `${leg.routeId.replace(/^HSL:/, "")}/${leg.directionId + 1}/${leg.tripStart}`;
}

/**
 * One marker per train: coupled metro/train units each report their own
 * position, so same-line vehicles within ~50 m are merged (first kept).
 * @param {Vehicle[]} list @returns {Vehicle[]}
 */
export function mergeCoupled(list) {
  /** @type {Vehicle[]} */
  const out = [];
  for (const v of list) {
    const near = out.some(
      (o) =>
        o.line === v.line &&
        Math.hypot((o.lat - v.lat) * 111_320, (o.lon - v.lon) * 55_800) < 50,
    );
    if (!near) out.push(v);
  }
  return out;
}

/**
 * WebSocket glue: connects, subscribes to the given topics, calls
 * onVehicle per position, pings to keep the connection, and reconnects a
 * few times if the server drops it.
 */
export class HfpClient {
  /**
   * @param {(v: Vehicle) => void} onVehicle
   * @param {{url?: string, WebSocketImpl?: typeof WebSocket}} [opts]
   */
  constructor(onVehicle, { url = HFP_URL, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.onVehicle = onVehicle;
    this.url = url;
    this.WS = WebSocketImpl;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {string[]} */
    this.topics = [];
    this.nextId = 1;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.ping = undefined;
    this.rest = new Uint8Array(0);
    this.retries = 0;
    this.closed = true;
  }

  /** Replace the subscriptions; connects on first use. @param {string[]} topics */
  subscribe(topics) {
    const old = this.topics;
    this.topics = [...new Set(topics)];
    this.closed = false;
    if (!this.ws) {
      this.#connect();
      return;
    }
    if (this.ws.readyState !== 1) return; // sent on CONNACK
    const gone = old.filter((t) => !this.topics.includes(t));
    const added = this.topics.filter((t) => !old.includes(t));
    if (gone.length) this.ws.send(encodeUnsubscribe(this.nextId++, gone));
    if (added.length) this.ws.send(encodeSubscribe(this.nextId++, added));
  }

  /** Disconnect and forget the subscriptions. */
  close() {
    this.closed = true;
    this.topics = [];
    clearInterval(this.ping);
    if (this.ws?.readyState === 1) this.ws.send(DISCONNECT);
    this.ws?.close();
    this.ws = null;
  }

  #connect() {
    // "mqtt" is the WebSocket subprotocol MQTT brokers expect.
    const ws = new this.WS(this.url, "mqtt");
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const id = `hoppu-${Math.random().toString(36).slice(2, 10)}`;
      ws.send(encodeConnect(id, 60));
    };
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(/** @type {ArrayBuffer} */ (e.data));
      const buf = new Uint8Array(this.rest.length + chunk.length);
      buf.set(this.rest);
      buf.set(chunk, this.rest.length);
      const { packets, rest } = decodePackets(buf);
      this.rest = rest;
      for (const p of packets) this.#handle(p);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      // Dropped while still wanted: retry with backoff, a few times.
      if (!this.closed && this.retries < 5) {
        this.retries++;
        setTimeout(() => !this.closed && !this.ws && this.#connect(), 2000 * this.retries);
      }
    };
  }

  /** @param {RawPacket} p */
  #handle(p) {
    if (p.type === 2) {
      // CONNACK: body[1] is the return code, 0 = accepted.
      if (p.body[1] !== 0) return this.ws?.close();
      this.retries = 0;
      if (this.topics.length) this.ws?.send(encodeSubscribe(this.nextId++, this.topics));
      this.ping = setInterval(() => this.ws?.readyState === 1 && this.ws.send(PINGREQ), 45_000);
    } else if (p.type === 3) {
      const { topic, payload } = decodePublish(p.body);
      const v = parseVehicle(topic, payload);
      if (v) this.onVehicle(v);
    }
    // SUBACK (9), UNSUBACK (11), PINGRESP (13): nothing to do.
  }
}
