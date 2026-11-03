// @ts-check
/**
 * Decoder for Google's "encoded polyline" format, which OTP uses for leg
 * shapes (legGeometry.points).
 *
 * Format: each coordinate is stored as the difference from the previous one,
 * multiplied by 1e5 and rounded. The signed integer is zigzag-encoded (sign
 * moved to the lowest bit), then split into 5-bit chunks, least significant
 * first. Every chunk except the last has bit 0x20 set ("more follows"), and
 * 63 is added so each chunk is a printable ASCII character.
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */

/**
 * @param {string} encoded
 * @param {number} [precision]  decimal digits; 5 for OTP and Google
 * @returns {[number, number][]} [lat, lon] pairs
 */
export function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  /** @type {[number, number][]} */
  const points = [];
  let i = 0;
  let lat = 0;
  let lon = 0;

  /** Read one zigzag-encoded varint starting at i. */
  const next = () => {
    let result = 0;
    let shift = 0;
    let chunk;
    do {
      chunk = encoded.charCodeAt(i++) - 63;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
    } while (chunk >= 0x20);
    // Undo zigzag: lowest bit is the sign, the rest the magnitude.
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (i < encoded.length) {
    lat += next();
    lon += next();
    points.push([lat / factor, lon / factor]);
  }
  return points;
}
