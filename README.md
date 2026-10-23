# Turbulence

An iPhone web app that answers "How bumpy will my flight be?"

- **Plan a trip**: enter From, To and the departure time from your ticket, up to 15 days ahead. You get a 1–5 bumpiness rating, a one-line summary, a takeoff, cruise and landing breakdown, and when to expect bumps.
- **Pilot reports**: a live feed of what pilots are reporting right now ("Moderate bumps · 35,000 ft · 60 mi NE of Denver · Boeing 737 · 4 min ago"). Newest first, updates every minute, and can be filtered to bumpy reports only or to reports near your trip.
- **Live flight**: track a plane that's in the air now (e.g. `UAL123`) and get the forecast for the rest of its trip. Position updates every 30 s.

## Where the forecast comes from

- **Weather forecast** (NOAA GFS model via Open-Meteo, free): winds at every altitude along your route at the time you'll be there. Sharp changes in wind with height near the jet stream are the main cause of clear-air turbulence. The forecast also checks for thunderstorms, unstable air, and gusty winds at both airports.
- **Live reports** (NOAA Aviation Weather Center): pilot reports from the last 3 hours and official turbulence and thunderstorm warnings. These are used for flights leaving within the next few hours. They refresh every 5 minutes.
- **Weather radar** (RainViewer, free for personal use): rain and storms from the last few minutes, as an optional map layer.
- **Live positions and routes** (adsb.lol, with airplanes.live and adsb.fi as backups; OpenSky as a last resort). Free, no key needed, and they work from hosting services like Render.

Confidence is highest on the day of travel and drops for trips more than 2–4 days out. Turbulence can't be predicted perfectly, so this is for peace of mind, not flight operations.

## Run it on your Mac

You need Node.js 18 or newer (nodejs.org → macOS Installer). Then, in Terminal:

```
cd ~/Downloads/turbulence-app
node server.js
```

Leave Terminal open. It prints an address like `http://192.168.1.23:3000`.

## Open it on your iPhone

1. Connect your iPhone to the same Wi‑Fi as your Mac.
2. In Safari, type the address Terminal printed (`http://192.168.x.x:3000`).
3. Optional: tap Share → **Add to Home Screen**. It then opens like an app.

It only works while your Mac is on, awake, and running `node server.js`, and while your iPhone is on the same Wi‑Fi. To use it anywhere, it needs hosting online.

## Optional: real flight paths (FlightAware, paid)

With a FlightAware AeroAPI key, Live flight shows the plane's **actual track** since takeoff and the airline's **filed flight plan** ahead, and the turbulence forecast follows that real route. The Personal plan has no monthly fee and includes $5 of free usage a month. This app uses about 3 lookups per tracked flight (cached).

1. Sign up at flightaware.com/aeroapi (Personal tier) and create an API key.
2. On Render: your service → **Environment** → **Add Environment Variable**: `FLIGHTAWARE_API_KEY` = your key → **Save**.
   On your Mac instead: `FLIGHTAWARE_API_KEY=your-key node server.js`

Without a key, everything still works and the paths are estimated.

## Optional: more live-flight lookups

Without an account, OpenSky allows about 400 lookups a day. A free account raises that to 4,000 and allows 15‑second updates. Create an API client on your OpenSky account page, then start the server like this:

```
OPENSKY_CLIENT_ID=your-id OPENSKY_CLIENT_SECRET=your-secret node server.js
```

## Files

- `server.js`: web server; fetches and caches all the data
- `lib/plan.js`: flight path, bumpiness scoring and the plain-English summary
- `lib/weather.js`: weather forecast along the route
- `lib/normalize.js`: pilot reports and warnings
- `public/`: the iPhone web app
- `test/`: offline tests (`node test/test.js`)
