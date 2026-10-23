// Great-circle helpers. Positions are [lat, lon] in degrees, distances in nautical miles.
'use strict';
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distanceNm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function destinationPoint(p, bearingDeg, distNm) {
  const d = distNm / R_NM, b = rad(bearingDeg), la = rad(p[0]), lo = rad(p[1]);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(la2), ((deg(lo2) + 540) % 360) - 180];
}

// Point a fraction f of the way along the great circle from a to b.
function interpolate(a, b, f) {
  const la1 = rad(a[0]), lo1 = rad(a[1]), la2 = rad(b[0]), lo2 = rad(b[1]);
  const d = distanceNm(a, b) / R_NM;
  if (d < 1e-9) return a.slice();
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return [deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))];
}

// Ray-casting point-in-polygon, with longitudes unwrapped around the point (date line safe).
function inPolygon(pt, poly) {
  const [y, x0] = pt;
  let inside = false;
  const ux = (lon) => { let d = lon - x0; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = ux(poly[i][1]), yj = poly[j][0], xj = ux(poly[j][1]);
    if ((yi > y) !== (yj > y) && 0 < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

module.exports = { distanceNm, destinationPoint, interpolate, inPolygon };
