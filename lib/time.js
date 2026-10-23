// Time-zone helpers using the built-in Intl database (handles daylight saving correctly).
'use strict';

// Offset of a time zone from UTC, in minutes, at a given instant.
function offsetMinutes(timeZone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

// "2026-10-24T08:30" as wall-clock time in `timeZone` → UTC milliseconds.
function localToUtc(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
  if (!m) return NaN;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = naive - offsetMinutes(timeZone, naive) * 60000;
  utc = naive - offsetMinutes(timeZone, utc) * 60000; // second pass settles DST edges
  return utc;
}

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { offsetMinutes, localToUtc, validZone };
