// Turns a lat/lon into a friendly place like "60 mi NE of Denver", and aircraft codes into names.
'use strict';
const { distanceNm } = require('./geo');

// Major cities, approximate centres (only used for "near X" labels).
const CITIES = [
  ['Seattle', 47.61, -122.33], ['Portland', 45.52, -122.68], ['San Francisco', 37.77, -122.42], ['Sacramento', 38.58, -121.49],
  ['Los Angeles', 34.05, -118.24], ['San Diego', 32.72, -117.16], ['Las Vegas', 36.17, -115.14], ['Reno', 39.53, -119.81],
  ['Phoenix', 33.45, -112.07], ['Tucson', 32.22, -110.97], ['Salt Lake City', 40.76, -111.89], ['Boise', 43.62, -116.2],
  ['Denver', 39.74, -104.99], ['Albuquerque', 35.08, -106.65], ['El Paso', 31.76, -106.49], ['Billings', 45.78, -108.5],
  ['Cheyenne', 41.14, -104.82], ['Rapid City', 44.08, -103.23], ['Bismarck', 46.81, -100.78], ['Fargo', 46.88, -96.79],
  ['Minneapolis', 44.98, -93.27], ['Omaha', 41.26, -95.93], ['Kansas City', 39.1, -94.58], ['Wichita', 37.69, -97.34],
  ['Oklahoma City', 35.47, -97.52], ['Amarillo', 35.22, -101.83], ['Dallas', 32.78, -96.8], ['Austin', 30.27, -97.74],
  ['San Antonio', 29.42, -98.49], ['Houston', 29.76, -95.37], ['New Orleans', 29.95, -90.07], ['Memphis', 35.15, -90.05],
  ['Little Rock', 34.75, -92.29], ['St. Louis', 38.63, -90.2], ['Chicago', 41.88, -87.63], ['Milwaukee', 43.04, -87.91],
  ['Des Moines', 41.59, -93.62], ['Indianapolis', 39.77, -86.16], ['Detroit', 42.33, -83.05], ['Cleveland', 41.5, -81.69],
  ['Columbus', 39.96, -83.0], ['Cincinnati', 39.1, -84.51], ['Louisville', 38.25, -85.76], ['Nashville', 36.16, -86.78],
  ['Atlanta', 33.75, -84.39], ['Birmingham', 33.52, -86.8], ['Jacksonville', 30.33, -81.66], ['Orlando', 28.54, -81.38],
  ['Tampa', 27.95, -82.46], ['Miami', 25.76, -80.19], ['Charlotte', 35.23, -80.84], ['Raleigh', 35.78, -78.64],
  ['Charleston', 32.78, -79.93], ['Washington DC', 38.91, -77.04], ['Baltimore', 39.29, -76.61], ['Philadelphia', 39.95, -75.17],
  ['Pittsburgh', 40.44, -80.0], ['New York', 40.71, -74.01], ['Boston', 42.36, -71.06], ['Buffalo', 42.89, -78.88],
  ['Albany', 42.65, -73.75], ['Portland, Maine', 43.66, -70.26], ['Anchorage', 61.22, -149.9], ['Fairbanks', 64.84, -147.72],
  ['Juneau', 58.3, -134.42], ['Honolulu', 21.31, -157.86], ['Vancouver', 49.28, -123.12], ['Calgary', 51.05, -114.07],
  ['Winnipeg', 49.9, -97.14], ['Toronto', 43.65, -79.38], ['Montreal', 45.5, -73.57], ['Halifax', 44.65, -63.58],
  ['Monterrey', 25.69, -100.32], ['Mexico City', 19.43, -99.13], ['Cancún', 21.16, -86.85], ['Havana', 23.11, -82.37],
  ['San Juan', 18.47, -66.11], ['London', 51.51, -0.13], ['Reykjavik', 64.15, -21.94], ['Tokyo', 35.68, 139.69],
];
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function describePlace(lat, lon) {
  let best = null;
  for (const [name, la, lo] of CITIES) {
    const d = distanceNm([la, lo], [lat, lon]);
    if (!best || d < best.d) best = { name, la, lo, d };
  }
  const mi = Math.round((best.d * 1.15078) / 10) * 10;
  if (best.d * 1.15078 > 400) {
    if (lon < -125 && lat < 60) return 'Over the Pacific';
    if (lon > -70 && lon < -10 && lat > 20) return 'Over the Atlantic';
    if (lat > 22 && lat < 31 && lon > -98 && lon < -81) return 'Over the Gulf';
    return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  }
  if (mi < 15) return `Near ${best.name}`;
  const dir = DIRS[Math.round(bearing([best.la, best.lo], [lat, lon]) / 45) % 8];
  return `${mi} mi ${dir} of ${best.name}`;
}

const TYPES = [
  [/^(B73\d|B3[789]M|B3XM|B737|B738|B739)$/, 'Boeing 737'], [/^B75\d$/, 'Boeing 757'], [/^B76\d$/, 'Boeing 767'],
  [/^(B77\d|B77[WL])$/, 'Boeing 777'], [/^B78\w$/, 'Boeing 787'], [/^B74\d$/, 'Boeing 747'], [/^B71\d$/, 'Boeing 717'],
  [/^A31[89]$|^A32\d$|^A2[01]N$|^A19N$/, 'Airbus A320 family'], [/^A33\d$|^A339$/, 'Airbus A330'], [/^A35\w$/, 'Airbus A350'],
  [/^A38\d$/, 'Airbus A380'], [/^BCS[13]$/, 'Airbus A220'], [/^E1[79]\d$|^E7[05]\w?$|^E75[LS]$/, 'Embraer regional jet'],
  [/^E1[349]5$/, 'Embraer regional jet'], [/^CRJ\w$/, 'CRJ regional jet'], [/^DH8\w$/, 'Dash 8 turboprop'],
  [/^AT[47]\w$/, 'ATR turboprop'], [/^MD[89]\w$/, 'MD-80/90'], [/^C208$/, 'Cessna Caravan'], [/^PC12$/, 'Pilatus PC-12'],
  [/^BE\d\w*$/, 'Beechcraft'], [/^C1[5-8]\d$/, 'Small Cessna'], [/^PA\d+$/, 'Small Piper'], [/^SR2\d$/, 'Cirrus'],
  [/^(C[5-7]\d\w*|GLF\d|GL[57]T|CL\d0|LJ\d\d|FA\d\w|E55P|E50P|HDJT)$/, 'Business jet'],
];
function aircraftName(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return '';
  for (const [re, name] of TYPES) if (re.test(c)) return name;
  if (/^[A-Z]{3}\d{1,4}[A-Z]?$/.test(c)) return `Flight ${c}`; // airline callsign
  return c;
}

module.exports = { describePlace, aircraftName };
