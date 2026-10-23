(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('tt.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('tt.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const state = { mode: 'plan', result: null, live: null, liveTimer: null, fcTimer: null, fcAt: 0, refreshSec: 30, fetchedAt: 0, turb: null };

  // ---------- formatting ----------
  const fmtTime = (ms, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(ms);
  const fmtDay = (ms, tz) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz || undefined }).format(ms);
  const dur = (m) => { m = Math.round(m); if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; };
  const niceName = (a) => {
    if (!a) return '';
    const n = (a.name || '').split('/')[0].trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return n || a.id;
  };
  const code = (a) => (a && (a.iata || a.id)) || '';
  const cityName = (a) => (a && a.name && a.name.includes('/') ? niceName(a) : a && a.name ? a.name : '');
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s < 10 ? 'just now' : `${s}s ago`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min ' : ''}ago`;
  };
  const cleanCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ---------- tabs ----------
  function setMode(mode) {
    const prev = state.mode;
    state.mode = mode;
    $('tabPlan').setAttribute('aria-selected', mode === 'plan');
    $('tabLive').setAttribute('aria-selected', mode === 'live');
    $('tabFeed').setAttribute('aria-selected', mode === 'feed');
    $('planForm').classList.toggle('hidden', mode !== 'plan');
    $('liveForm').classList.toggle('hidden', mode !== 'live');
    $('feed').classList.toggle('hidden', mode !== 'feed');
    hideError();
    if (mode === 'feed') { $('results').classList.add('hidden'); loadFeed(); return; }
    clearTimeout(feedState.timer);
    if (prev === 'feed' && state.result && (mode === 'plan' ? !state.result.live : state.live)) { $('results').classList.remove('hidden'); return; }
    if (mode === 'plan') stopLive(true);
    $('results').classList.add('hidden');
  }
  $('tabPlan').onclick = () => setMode('plan');
  $('tabLive').onclick = () => setMode('live');
  $('tabFeed').onclick = () => setMode('feed');

  // ---------- live pilot-report feed ----------
  const feedState = { data: null, timer: null, seen: null, filter: store.get('feedFilter') || 'bumpy', open: new Set() };
  const feedLevel = (s) => (s < 0.5 ? 'Smooth ride' : s < 0.75 ? 'Mostly smooth' : s < 1.5 ? 'Light bumps' : s < 2.25 ? 'Moderate bumps' : s < 3 ? 'Strong bumps' : 'Severe turbulence');
  const feedColor = (s) => (s < 0.75 ? '#34c759' : s < 1.5 ? '#c7cf2f' : s < 2.25 ? '#ff9500' : s < 3 ? '#ff3b30' : '#af52de');
  const ft = (v) => `${(Math.round(v / 1000)).toLocaleString()},000 ft`;
  const nm = (a, b) => {
    const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  function setFeedFilter(f) {
    feedState.filter = f; store.set('feedFilter', f);
    [...$('feedFilter').children].forEach((b) => b.setAttribute('aria-selected', b.dataset.f === f));
    renderFeed(false);
  }
  [...$('feedFilter').children].forEach((b) => { b.onclick = () => setFeedFilter(b.dataset.f); });
  setFeedFilter(feedState.filter);

  async function loadFeed() {
    clearTimeout(feedState.timer);
    let wait = 60;
    try {
      const d = await getJSON('/api/pireps');
      const firstLoad = !feedState.seen;
      const prevSeen = feedState.seen || new Set();
      feedState.data = d;
      wait = d.refreshSec || 60;
      const fresh = firstLoad ? new Set() : new Set(d.reports.filter((r) => !prevSeen.has(r.id)).map((r) => r.id));
      feedState.seen = new Set(d.reports.map((r) => r.id));
      renderFeed(fresh);
    } catch (e) {
      $('feedFresh').textContent = 'Couldn’t load reports — retrying…';
      wait = 30;
    }
    if (state.mode === 'feed' && !document.hidden) feedState.timer = setTimeout(loadFeed, wait * 1000);
  }

  function renderFeed(fresh) {
    const d = feedState.data;
    if (!d) return;
    let list = d.reports;
    const f = feedState.filter;
    if (f === 'bumpy') list = list.filter((r) => r.intensity >= 0.75);
    let note = '';
    if (f === 'trip') {
      const o = state.result;
      if (!o) { $('feedList').innerHTML = '<li class="empty" style="display:block">Check a trip on the “Plan a trip” tab first, then come back to see reports along your route.</li>'; $('newCount').classList.add('hidden'); return; }
      const route = o.points.map((p) => [p.lat, p.lon]);
      list = list.filter((r) => route.some((p) => nm(p, [r.lat, r.lon]) < 100));
      note = o.live ? 'along this flight’s path' : `near ${code(o.origin)} → ${code(o.dest)}`;
    }
    const newOnes = fresh && fresh.size ? list.filter((r) => fresh.has(r.id)).length : 0;
    $('newCount').textContent = `${newOnes} new`;
    $('newCount').classList.toggle('hidden', !newOnes);
    if (!list.length) {
      $('feedList').innerHTML = `<li class="empty" style="display:block">${f === 'bumpy' ? 'No bumpy reports in the last 3 hours. Smooth skies.' : f === 'trip' ? `No pilot reports ${esc(note)} in the last 3 hours.` : 'No pilot reports right now.'}</li>`;
      return;
    }
    $('feedList').innerHTML = list.slice(0, 120).map((r) => {
      const alt = r.baseFt != null && r.topFt != null && r.topFt - r.baseFt >= 1000 ? `${(Math.round(r.baseFt / 1000)).toLocaleString()},000–${ft(r.topFt)}` : ft(r.altFt);
      return `<li data-id="${esc(r.id)}" class="${fresh && fresh.has && fresh.has(r.id) ? 'new' : ''}">
        <span class="d" style="background:${feedColor(r.intensity)}"></span>
        <span class="t">${esc(feedLevel(r.intensity))}${r.urgent ? '<span class="badge">URGENT</span>' : ''}</span>
        <span class="r" data-time="${r.time}">${esc(ago(r.time))}</span>
        <span class="lvl">${esc(alt)} · ${esc(r.place)}</span>
        ${r.aircraft ? `<span class="s">${esc(r.aircraft)}</span>` : ''}
        ${feedState.open.has(r.id) && r.raw ? `<span class="raw">${esc(r.raw)}</span>` : ''}
      </li>`;
    }).join('');
    // Fade the "new" highlight after a few seconds.
    setTimeout(() => document.querySelectorAll('#feedList li.new').forEach((li) => li.classList.remove('new')), 4000);
    updateFeedTimes();
  }
  function updateFeedTimes() {
    if (!feedState.data) return;
    $('feedFresh').textContent = `Updated ${ago(feedState.data.updated)} · ${feedState.data.reports.length} reports, last 3 hours`;
    document.querySelectorAll('#feedList [data-time]').forEach((el) => { el.textContent = ago(Number(el.dataset.time)); });
  }
  setInterval(() => { if (state.mode === 'feed') updateFeedTimes(); }, 5000);
  $('feedList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    if (feedState.open.has(id)) feedState.open.delete(id); else feedState.open.add(id);
    renderFeed(false);
  });

  // ---------- errors & buttons ----------
  function showError(msg) { const e = $('error'); e.textContent = msg; e.classList.remove('hidden'); }
  function hideError() { $('error').classList.add('hidden'); }
  function busy(btn, on, label) {
    btn.disabled = on;
    btn.innerHTML = on ? `<span class="spin"></span>${esc(label)}` : esc(btn.dataset.label || btn.textContent);
  }
  ['planBtn', 'liveBtn'].forEach((id) => { $(id).dataset.label = $(id).textContent; });

  async function getJSON(url) {
    const r = await fetch(url);
    let data = null;
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error((data && data.error) || 'Something went wrong. Is the server still running on your Mac?'), { status: r.status });
    return data;
  }

  // ---------- plan form ----------
  const pad = (n) => String(n).padStart(2, '0');
  function defaultDeparture() {
    const d = new Date(Date.now() + 2 * 3600000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  (function initPlan() {
    const saved = store.get('plan') || {};
    const def = defaultDeparture();
    $('from').value = saved.from || '';
    $('to').value = saved.to || '';
    const savedWhen = saved.date && saved.time && Date.parse(`${saved.date}T${saved.time}`) > Date.now() ? saved : def;
    $('date').value = savedWhen.date; $('time').value = savedWhen.time;
    const today = new Date();
    $('date').min = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const max = new Date(Date.now() + 15 * 86400000);
    $('date').max = `${max.getFullYear()}-${pad(max.getMonth() + 1)}-${pad(max.getDate())}`;
    $('flight').value = (store.get('live') || {}).flight || '';
    $('liveTo').value = (store.get('live') || {}).to || '';
  })();
  ['from', 'to', 'flight', 'liveTo'].forEach((id) => $(id).addEventListener('input', (e) => {
    const v = cleanCode(e.target.value); if (v !== e.target.value) e.target.value = v;
    if (id === 'from') $('fromName').textContent = '';
    if (id === 'to') $('toName').textContent = '';
  }));
  $('swapBtn').onclick = () => {
    const a = $('from').value; $('from').value = $('to').value; $('to').value = a;
    const n = $('fromName').textContent; $('fromName').textContent = $('toName').textContent; $('toName').textContent = n;
  };

  $('planForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const from = cleanCode($('from').value), to = cleanCode($('to').value);
    if (!from || !to) return showError('Enter both airports, like SFO and JFK.');
    if (!$('date').value || !$('time').value) return showError('Pick a departure date and time.');
    document.activeElement && document.activeElement.blur();
    store.set('plan', { from, to, date: $('date').value, time: $('time').value });
    busy($('planBtn'), true, 'Checking the skies…');
    try {
      const o = await getJSON(`/api/forecast?from=${from}&to=${to}&depart=${$('date').value}T${$('time').value}`);
      $('fromName').textContent = niceName(o.origin);
      $('toName').textContent = niceName(o.dest);
      const u = new URL(location.href);
      u.search = `?from=${from}&to=${to}&depart=${$('date').value}T${$('time').value}`;
      history.replaceState(null, '', u);
      render(o);
    } catch (err) {
      showError(err.message);
      $('results').classList.add('hidden');
    } finally {
      busy($('planBtn'), false);
    }
  });

  // ---------- results ----------
  function render(o, refit) {
    state.result = o;
    const r = o.rating;
    $('results').classList.remove('hidden');
    [...$('meter').children].forEach((el, i) => { el.style.background = i < r.score ? r.color : ''; });
    $('rLabel').textContent = r.label;
    $('rLabel').style.color = r.color;
    $('rHeadline').textContent = r.headline;
    $('rAdvice').textContent = r.advice;

    const oTz = o.origin && o.origin.tz, dTz = o.dest && o.dest.tz;
    if (o.live) {
      $('rMeta').textContent = o.dest ? `To ${code(o.dest)} · about ${dur(o.durationMin)} left · lands around ${fmtTime(o.arriveUtc, dTz)}` : 'Next 2 hours on the current heading';
    } else {
      $('rMeta').textContent = `${code(o.origin)} → ${code(o.dest)} · ${fmtDay(o.departUtc, oTz)} · ${dur(o.durationMin)} · ${o.distanceMi.toLocaleString()} mi · cruising ${o.cruiseText}`;
    }

    // Strip: one block per forecast point.
    $('strip').innerHTML = o.points.map((p) => `<i style="flex:1;background:${p.color}"></i>`).join('');
    $('stripLabels').innerHTML = o.live
      ? `<span>Now</span><span>${o.dest ? 'Landing ' + esc(fmtTime(o.arriveUtc, dTz)) : '+2 h'}</span>`
      : `<span>Takeoff ${esc(fmtTime(o.departUtc, oTz))}</span><span>Landing ${esc(fmtTime(o.arriveUtc, dTz))}${dTz && oTz !== dTz ? ' local' : ''}</span>`;

    $('phases').innerHTML = o.phases.map((p) => `
      <li>
        <span class="d" style="background:${p.level.color}"></span>
        <span class="t">${esc(p.title)}</span>
        <span class="r">${esc(phaseTime(p, o))}</span>
        <span class="lvl">${esc(p.text)}</span>
        ${p.why ? `<span class="s">${esc(p.why)}</span>` : ''}
      </li>`).join('');

    if (o.segments.length) {
      $('bumps').innerHTML = o.segments.map((s, i) => `
        <li data-i="${i}">
          <span class="d" style="background:${s.level.color}"></span>
          <span class="t">${esc(s.level.name)}</span>
          <span class="r">${s.startT < 3 ? (o.live ? 'Now' : 'At takeoff') : `${o.live ? 'In ' : ''}${esc(dur(Math.round(s.startT / 5) * 5 || s.startT))}${o.live ? '' : ' in'}`}</span>
          <span class="lvl">Lasting about ${esc(dur(Math.max(5, Math.round(s.minutes / 5) * 5)))}</span>
          ${s.reasons.length ? `<span class="s">${esc(s.reasons.join(' · '))}</span>` : ''}
        </li>`).join('');
    } else {
      $('bumps').innerHTML = '<li class="empty" style="display:block">None expected. Enjoy the ride.</li>';
    }

    $('confLabel').textContent = o.confidence.label;
    $('confText').textContent = o.confidence.text + (o.warnings && o.warnings.length ? ' ' + o.warnings.join(' ') : '');
    drawRoute(refit !== false && (refit === undefined || refit));
  }

  function phaseTime(p, o) {
    if (o.live) return '';
    const len = p.endT - p.startT;
    return len >= 1 ? dur(len) : '';
  }

  $('bumps').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li || !state.result) return;
    const s = state.result.segments[Number(li.dataset.i)];
    $('mapWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    const pts = state.result.points.filter((p) => p.t >= s.startT - 1 && p.t <= s.endT + 1).map((p) => [p.lat, p.lon]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(1.2), { maxZoom: 7 });
  });

  // ---------- map ----------
  const dark = false; // the pink theme is always light
  const map = L.map('map', { zoomSnap: 0.25, zoomControl: false, attributionControl: true, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, worldCopyJump: true }).setView([39, -97], 3);
  // Esri's clean grey basemaps: free to use with attribution, no key needed.
  L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base'}/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 12, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors',
  }).addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const planeLayer = L.layerGroup().addTo(map);
  const reportLayer = L.layerGroup();

  // Great-circle points between two [lat, lon] positions, so long lines curve like real flight paths.
  function gcLine(a, b, n) {
    const r = Math.PI / 180, out = [];
    const [la1, lo1, la2, lo2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2));
    if (d < 1e-6) return [a, b];
    n = n || Math.max(2, Math.ceil(d / r / 2));
    let prevLon = null;
    for (let i = 0; i <= n; i++) {
      const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      let lon = Math.atan2(y, x) / r;
      if (prevLon != null) { while (lon - prevLon > 180) lon -= 360; while (lon - prevLon < -180) lon += 360; }
      prevLon = lon;
      out.push([Math.atan2(z, Math.sqrt(x * x + y * y)) / r, lon]);
    }
    return out;
  }

  function drawRoute(refit) {
    routeLayer.clearLayers();
    const o = state.result;
    if (!o) return;
    const pinIcon = () => L.divIcon({ className: '', html: '<div class="ap-pin"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
    const live = o.live && state.plane;
    const elapsed = live ? (Date.now() - o.departUtc) / 60000 : 0;
    const here = live ? planeNow() : null;

    // Path ahead: [lat, lon, colour, minute] every 2 min along the exact route (filed plan when available).
    let ahead = (o.line && o.line.length ? o.line : o.points.map((p) => [p.lat, p.lon, p.color, p.t]));
    if (live) {
      const rest = ahead.filter((p) => p[3] > elapsed);
      ahead = [[here[0], here[1], (rest[0] || ahead[ahead.length - 1])[2], elapsed], ...rest];
    }

    if (live) {
      // Path behind: the real track when we have it, otherwise departure airport → what we've seen → now.
      const trail = (state.trail || []).slice();
      const rt = state.liveRoute;
      const flown = [];
      if (!state.trailIsComplete && rt && rt.origin) flown.push(...gcLine([rt.origin.lat, rt.origin.lon], trail[0] || here));
      flown.push(...trail, here);
      if (flown.length > 1) {
        L.polyline(flown, state.trailIsComplete
          ? { color: '#b0748d', weight: 3.5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }
          : { color: '#c98aa3', weight: 3, dashArray: '2 7', lineCap: 'round', opacity: 0.9 }).addTo(routeLayer);
      }
      if (rt && rt.origin) L.marker([rt.origin.lat, rt.origin.lon], { icon: pinIcon() }).bindTooltip(code(rt.origin), { permanent: true, direction: 'left', offset: [-8, 0] }).addTo(routeLayer);
    }

    // White halo, then the forecast colours on top (one polyline per run of the same colour).
    L.polyline(ahead.map((p) => [p[0], p[1]]), { color: '#fff', weight: 9, opacity: 0.85, lineJoin: 'round' }).addTo(routeLayer);
    let run = [ahead[0]];
    const flush = () => {
      if (run.length < 2) return;
      const mid = run[Math.floor(run.length / 2)];
      const sp = o.points.reduce((a, b) => (Math.abs(b.t - mid[3]) < Math.abs(a.t - mid[3]) ? b : a));
      L.polyline(run.map((p) => [p[0], p[1]]), { color: run[1][2], weight: 5, lineCap: 'round', lineJoin: 'round' })
        .bindPopup(`<b>${esc(sp.levelName)}</b><br>${esc(o.live ? 'In' : 'About')} ${esc(dur(Math.max(0, mid[3] - elapsed)))}${o.live ? '' : ' into the flight'} · ${esc(Math.round(sp.altFt / 1000))},000 ft${sp.why ? '<br>' + esc(sp.why) : ''}`)
        .addTo(routeLayer);
    };
    for (let i = 1; i < ahead.length; i++) {
      if (ahead[i][2] !== run[run.length - 1][2] && run.length > 1) { flush(); run = [run[run.length - 1]]; }
      run.push(ahead[i]);
    }
    flush();

    if (!o.live && o.origin) L.marker([o.origin.lat, o.origin.lon], { icon: pinIcon() }).bindTooltip(code(o.origin), { permanent: true, direction: 'left', offset: [-8, 0] }).addTo(routeLayer);
    if (o.dest) L.marker([o.dest.lat, o.dest.lon], { icon: pinIcon() }).bindTooltip(code(o.dest), { permanent: true, direction: 'right', offset: [8, 0] }).addTo(routeLayer);

    // Where the line comes from, in plain words.
    $('pathNote').textContent = live
      ? (o.followsFiledRoute ? 'Ahead: the airline’s filed flight plan. ' : 'Ahead: estimated (shortest path) — real routes can curve. ')
        + (state.trailIsComplete ? 'Behind: the plane’s actual track.' : 'Behind: estimated, then actual since you started tracking.')
      : 'Estimated route (shortest path). Real routes follow air-traffic lanes and can curve.';

    if (refit !== false) {
      const b = L.latLngBounds(ahead.map((p) => [p[0], p[1]]));
      if (o.dest) b.extend([o.dest.lat, o.dest.lon]);
      if (live) { (state.trail || []).forEach((p) => b.extend(p)); if (state.liveRoute && state.liveRoute.origin) b.extend([state.liveRoute.origin.lat, state.liveRoute.origin.lon]); }
      setTimeout(() => { map.invalidateSize(); map.fitBounds(b, { maxZoom: 8, paddingTopLeft: [46, 30], paddingBottomRight: [46, 30] }); }, 50);
    }
    if ($('showReports').checked) drawReports();
  }

  // Expand to a full-screen, touchable map.
  $('mapBtn').onclick = () => {
    const full = $('mapWrap').classList.toggle('full');
    $('mapBtn').textContent = full ? 'Done' : 'Expand';
    ['dragging', 'touchZoom', 'doubleClickZoom'].forEach((h) => map[h][full ? 'enable' : 'disable']());
    document.body.style.overflow = full ? 'hidden' : '';
    setTimeout(() => { map.invalidateSize(); if (!full) drawRoute(); }, 60);
  };

  // Pilot reports & official warning areas (off by default to keep the map clean).
  const lvColor = (s) => (s < 0.75 ? '#34c759' : s < 1.5 ? '#c7cf2f' : s < 2.25 ? '#ff9500' : s < 3 ? '#ff3b30' : '#af52de');
  const plain = (s) => (s < 0.75 ? 'Smooth' : s < 1.5 ? 'Light bumps' : s < 2.25 ? 'Moderate bumps' : s < 3 ? 'Strong bumps' : 'Severe turbulence');
  async function drawReports() {
    reportLayer.clearLayers();
    try {
      if (!state.turb || Date.now() - state.turb.updated > 5 * 60000) state.turb = await getJSON('/api/turbulence');
    } catch { return; }
    if (!$('showReports').checked) return;
    const now = Date.now();
    for (const a of state.turb.areas) {
      if ((a.from != null && now < a.from) || (a.to != null && now > a.to)) continue;
      const storm = /Convective/.test(a.kind);
      L.polygon(a.poly, { color: lvColor(a.severity), weight: 1.5, fillOpacity: 0.1, dashArray: a.kind === 'G-AIRMET' ? '5 5' : null })
        .bindPopup(`<b>${storm ? 'Thunderstorm warning' : a.kind === 'G-AIRMET' ? 'Turbulence forecast area' : 'Turbulence warning'}</b><br>${esc(plain(a.severity))} · ${esc(Math.round(a.baseFt / 1000))},000–${esc(Math.round(a.topFt / 1000))},000 ft`)
        .addTo(reportLayer);
    }
    for (const p of state.turb.pireps) {
      L.circleMarker([p.lat, p.lon], { radius: 4 + p.intensity * 1.5, color: '#fff', weight: 1, fillColor: lvColor(p.intensity), fillOpacity: 0.9 })
        .bindPopup(`<b>Pilot report: ${esc(plain(p.intensity).toLowerCase())}</b><br>${esc(Math.round(p.altFt / 1000))},000 ft · ${esc(ago(p.time))}`)
        .addTo(reportLayer);
    }
  }
  $('showReports').addEventListener('change', (e) => {
    if (e.target.checked) { reportLayer.addTo(map); drawReports(); } else reportLayer.remove();
  });

  // ---------- live flight ----------
  $('liveForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const q = cleanCode($('flight').value), to = cleanCode($('liveTo').value);
    if (!q) return showError('Enter a flight, like UAL123.');
    document.activeElement && document.activeElement.blur();
    stopLive(true);
    store.set('live', { flight: q, to });
    state.live = { q, to };
    busy($('liveBtn'), true, 'Finding the flight…');
    try {
      await pollFlight(true);
      const u = new URL(location.href); u.search = `?flight=${q}${to ? '&to=' + to : ''}`; history.replaceState(null, '', u);
    } catch (err) {
      showError(err.message);
      state.live = null;
      $('results').classList.add('hidden');
    } finally {
      busy($('liveBtn'), false);
    }
  });
  $('stopBtn').onclick = () => { stopLive(false); $('results').classList.add('hidden'); };

  function stopLive(silent) {
    clearTimeout(state.liveTimer);
    state.live = null; state.fcAt = 0; state.fcDest = null; state.plane = null; state.trail = []; state.liveRoute = null;
    planeLayer.clearLayers(); planeMarker = null;
    $('liveTo').placeholder = 'JFK (optional)';
    $('liveBar').classList.add('hidden'); $('lbRoute').classList.add('hidden');
    if (!silent) { const u = new URL(location.href); u.search = ''; history.replaceState(null, '', u); }
  }

  // Plane position right now: last report moved forward at its speed and heading (max 90 s).
  function planeNow() {
    const f = state.plane;
    if (!f) return null;
    const dt = Math.min(90, Math.max(0, (Date.now() - (f.posTime || state.planeAt)) / 1000));
    if (!f.gsKt || f.onGround) return [f.lat, f.lon];
    const distNm = (f.gsKt * dt) / 3600, r = Math.PI / 180, d = distNm / 3440.065, b = (f.track || 0) * r, la = f.lat * r, lo = f.lon * r;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 / r, lo2 / r];
  }
  let planeMarker = null;
  function placePlane() {
    const f = state.plane;
    if (!f) return;
    const pos = planeNow();
    const html = `<svg class="plane-ico" width="30" height="30" viewBox="0 0 24 24" style="transform:rotate(${f.track || 0}deg)"><path fill="#d6336c" stroke="#fff" stroke-width="1.2" d="M12 2c.7 0 1.2.8 1.2 1.8v5.4l7.3 4.3v1.9l-7.3-2.2v4.6l2.2 1.6v1.6L12 20.1 8.6 21v-1.6l2.2-1.6v-4.6l-7.3 2.2v-1.9l7.3-4.3V3.8C10.8 2.8 11.3 2 12 2z"/></svg>`;
    if (!planeMarker || !planeLayer.hasLayer(planeMarker)) {
      planeLayer.clearLayers();
      planeMarker = L.marker(pos, { zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html }) }).addTo(planeLayer);
    } else {
      planeMarker.setLatLng(pos);
      planeMarker.setIcon(L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html }));
    }
  }
  // Glide the plane between position updates.
  setInterval(() => { if (state.live && state.plane && !document.hidden) { const p = planeNow(); if (planeMarker) planeMarker.setLatLng(p); } }, 1000);

  async function pollFlight(first) {
    clearTimeout(state.liveTimer);
    const L0 = state.live;
    if (!L0) return;
    let wait = state.refreshSec;
    try {
      const d = await getJSON(`/api/flight?q=${encodeURIComponent(L0.q)}`);
      if (state.live !== L0) return;
      const f = d.flight;
      state.refreshSec = d.refreshSec || 30; wait = state.refreshSec; state.fetchedAt = d.fetchedAt;
      state.plane = f; state.planeAt = Date.now();
      state.trail = d.trail || [];
      state.trailIsComplete = Boolean(d.trailIsComplete);
      if (d.route && d.route.plausible) state.liveRoute = d.route;
      const dest = L0.to || (state.liveRoute && (state.liveRoute.dest.iata || state.liveRoute.dest.id)) || '';
      if (!L0.to && dest && !$('liveTo').value) $('liveTo').placeholder = `${dest} (found automatically)`;
      $('liveBar').classList.remove('hidden');
      const rt = state.liveRoute;
      $('lbCall').textContent = f.callsign || f.icao24.toUpperCase();
      $('lbPlane').textContent = [f.airline, f.aircraft].filter(Boolean).join(' · ') || 'Aircraft type unknown';
      const fromAp = rt && rt.origin, toAp = L0.to ? (state.result && state.result.dest) || { iata: L0.to } : rt && rt.dest;
      if (fromAp || toAp) {
        $('lbRoute').classList.remove('hidden');
        $('lbFrom').textContent = fromAp ? code(fromAp) : '—';
        $('lbFromName').textContent = fromAp ? cityName(fromAp) : 'Unknown';
        $('lbTo').textContent = toAp ? code(toAp) : '—';
        $('lbToName').textContent = toAp ? cityName(toAp) : '';
      } else $('lbRoute').classList.add('hidden');
      const mph = f.gsKt != null ? Math.round(f.gsKt * 1.15078) : null;
      const doing = f.onGround ? 'On the ground' : f.vsFpm > 500 ? 'Climbing' : f.vsFpm < -500 ? 'Descending' : 'Cruising';
      $('lbStatus').textContent = f.onGround ? 'On the ground' : `${doing} at ${(Math.round(f.altFt / 100) * 100).toLocaleString()} ft${mph ? ` · ${mph} mph` : ''}`;
      placePlane();
      // Refresh the ride forecast every 5 minutes (weather doesn't change faster than that).
      if (first || Date.now() - state.fcAt > 5 * 60000 || dest !== state.fcDest) {
        state.fcAt = Date.now(); state.fcDest = dest;
        const o = await getJSON(`/api/forecast?lat=${f.lat}&lon=${f.lon}&alt=${f.altFt || 0}&gs=${f.gsKt || 0}&track=${f.track || 0}&vs=${f.vsFpm || 0}${dest ? '&to=' + dest : ''}&q=${encodeURIComponent(f.callsign || L0.q)}`);
        if (state.live !== L0) return;
        render(o, first);
        if (L0.to && o.dest) { $('lbTo').textContent = code(o.dest); $('lbToName').textContent = cityName(o.dest); $('lbRoute').classList.remove('hidden'); }
      } else {
        drawRoute(false); // keep the line attached to the moving plane
      }
      hideError();
    } catch (err) {
      if (first) throw err;
      showError(err.status === 404 ? 'Lost the flight’s signal — it may have landed. Retrying…' : 'Connection problem — retrying…');
      wait = Math.max(wait, 60);
    }
    state.liveTimer = setTimeout(() => pollFlight(false), wait * 1000);
  }
  setInterval(() => { if (state.live && state.fetchedAt) $('lbFresh').textContent = `updated ${ago(state.fetchedAt)}`; }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(state.liveTimer); clearTimeout(feedState.timer); return; }
    if (state.live) pollFlight(false);
    if (state.mode === 'feed') loadFeed();
  });

  // Tap the plane: it zooms off and comes back around.
  const plane = document.querySelector('.plane-title');
  if (plane) {
    plane.addEventListener('click', () => { plane.classList.remove('swoop'); void plane.getBoundingClientRect(); plane.classList.add('swoop'); });
    plane.addEventListener('animationend', (e) => { if (e.animationName === 'swoop') plane.classList.remove('swoop'); });
  }

  // ---------- open from a link ----------
  const qs = new URLSearchParams(location.search);
  if (qs.get('tab') === 'reports') {
    setMode('feed');
  } else if (qs.get('flight')) {
    setMode('live');
    $('flight').value = cleanCode(qs.get('flight'));
    $('liveTo').value = cleanCode(qs.get('to') || '');
    $('liveForm').requestSubmit();
  } else if (qs.get('from') && qs.get('to')) {
    $('from').value = cleanCode(qs.get('from'));
    $('to').value = cleanCode(qs.get('to'));
    const d = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(qs.get('depart') || '');
    if (d && Date.parse(`${d[1]}T${d[2]}`) > Date.now() - 3600000) { $('date').value = d[1]; $('time').value = d[2]; }
    $('planForm').requestSubmit();
  }
})();
