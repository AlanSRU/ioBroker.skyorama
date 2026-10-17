![Logo](admin/skyorama.png)
# ioBroker.skyorama

[![NPM version](https://img.shields.io/npm/v/iobroker.skyorama.svg)](https://www.npmjs.com/package/iobroker.skyorama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.skyorama.svg)](https://www.npmjs.com/package/iobroker.skyorama)
![Number of Installations](https://iobroker.live/badges/skyorama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/skyorama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.skyorama.png?downloads=true)](https://nodei.co/npm/iobroker.skyorama/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.skyorama/workflows/Test%20and%20Release/badge.svg)

## Skyorama adapter for ioBroker

What is in the sky over your location, as ioBroker states for automations, dashboards and alerts: aircraft nearby, the
visible passes of the ISS and other satellites, the moon and planets, how dark it is, what is worth looking at tonight, whether
the aurora can be seen from home right now, and lightning nearby.
Front-ends (dashboards, maps) can also ask the adapter directly for aircraft, a followed aircraft's position and
aircraft details.

Skyorama works anywhere: it uses the latitude and longitude from the ioBroker system settings (or a location entered
in the instance settings). Requires Node.js 22.13 or newer.

### Modules

Each module can be switched on or off in the instance settings. Switching a module off keeps its objects.

#### Aircraft

- Skyorama has no built-in aircraft data source: you choose and configure your own (off by default). It reads the
  readsb/tar1090 JSON format:
  - **area source** (required): your own receiver's `aircraft.json` ([readsb](https://github.com/wiedehopf/readsb),
    dump1090 or [tar1090](https://github.com/wiedehopf/tar1090)), or an API URL with the placeholders `{lat}`, `{lon}`
    and `{radiusNm}` (or `{radiusKm}`);
  - **aircraft lookup** (optional, with an optional fallback): one aircraft wherever it is, for following it, a URL
    with `{hex}`; the first is asked at most once a second;
  - **route lookup** (optional): route files in the [VRS standing data](https://github.com/vradarserver/standing-data)
    format, a URL with `{callsign}` and `{prefix}` (its first two characters);
  - an optional request header for services that need an API key (stored encrypted, and sent only to aircraft URLs on
    the area source's host).

  Check the terms of any service you use; many free community feeds are for personal, non-commercial use and ask for
  gentle request rates.
- Nothing is polled unless something needs it: a front-end asking through `sendTo` (every 10 seconds while asked, for
  the widest radius asked for in the last minute), or the optional background polling for the `aircraft.*` states.
- Details for one aircraft: the route (from the route lookup, if configured), a photo from
  [planespotters.net](https://www.planespotters.net/) (returned with the photographer's name and a link, as their terms
  ask) and the airline name from the VRS standing data airline list. They are loaded only when asked for and cached
  (routes 1 day, photos 7 days).

#### Aurora

Whether the aurora can actually be seen from home now, not just whether there is a geomagnetic storm somewhere:

- **dark enough**: the sun more than 12° below the horizon;
- **near enough**: the [NOAA SWPC OVATION](https://www.swpc.noaa.gov/products/aurora-30-minute-forecast) aurora
  forecast shows at least 10 % within 3° of latitude of you (usually poleward, where it shows low on the horizon; at
  high latitudes it can also be overhead or to the south, and the text says where to look), or
  [AuroraWatch UK](https://aurorawatch.lancs.ac.uk/) is amber or red (optional, for the UK);
- **not overcast**: cloud cover at home from [Open-Meteo](https://open-meteo.com/) below a limit (default 60 %).

These are fetched only while it is getting dark or dark (OVATION every 10 minutes, cloud every 15, AuroraWatch UK
every 5). If the [aurora-nowcast](https://github.com/chrmenne/ioBroker.aurora-nowcast) adapter is installed, its Kp
index is added to the text. An alert text is written when the aurora turns possible, at most once every 6 hours.

#### Lightning

Strikes from an MQTT feed in the [Blitzortung.org](https://www.blitzortung.org/) format (strike JSON published per
geohash, one character per topic level) that you configure: broker URL (`mqtt://`, `mqtts://`, `ws://` or `wss://`),
topic prefix and an optional login (the password is stored encrypted). The adapter subscribes only to the area around
you (the geohash cells that cover the configured radius). Off by default. Blitzortung data may be used for private,
non-commercial purposes only; check the terms of the feed you use.

An alert text is written for the first strike within the near radius (default 40 km) after half an hour without one.

#### Satellites

- Orbits come from [CelesTrak](https://celestrak.org/), fetched at most twice a day at a random time (CelesTrak blocks
  addresses that fetch the same data more often than every 2 hours). The last orbit set is kept, so a restart does not
  cause a new fetch. A change to the CelesTrak groups in the settings takes effect at most 2 hours after the last fetch.
- Visible passes over your location are worked out for the next 72 hours for the satellites you choose in the settings:
  up to 20 from the orbit set (with the default `visual` group, the ISS, Tiangong and about 150 of the brightest
  satellites; the ISS and Tiangong are chosen by default). A pass counts as
  visible when the satellite is lit by the sun, at least 10° above the horizon, and the sun at your location is more
  than 6° below the horizon.
- An alert text is written a set time before each visible pass that gets high enough (defaults: 10 minutes, 20°).

#### Astronomy

Calculated locally with [Astronomy Engine](https://github.com/cosinekitty/astronomy), no internet access: the
darkness (day, civil / nautical / astronomical twilight, night), the moon, the five naked-eye planets, and a summary
of tonight's sky: when it is dark, which planets are up, the moon, satellite passes, and bright deep-sky objects
that are well placed (for example the Andromeda Galaxy, the Pleiades or the Orion Nebula; in the southern hemisphere
also Omega Centauri and the Magellanic Clouds).

### Visualisation: the sky dome and the flight map

Two optional pages, switched on in the **Visualisation** tab and served by the
[web adapter](https://github.com/ioBroker/ioBroker.web) at `/skyorama/dome.html` and `/skyorama/map.html` (for example
`http://<ioBroker>:8082/skyorama/map.html`; `/skyorama/` links to both). While the visualisation is off, the pages say
so. Tap or click an aircraft on either page for its details: what it is doing, its airline and a photo (with the
photographer's credit), and its route if a route lookup is configured; it keeps updating while the box is open. Tracked
satellites show their next visible pass. `?units=km`, `mi` or `nm` sets the distance unit on both pages (default km).

**The sky dome** shows the sky above home (zenith in the middle, horizon at the edge, north at the top).

- The sky's colour follows the sun at your location: light blue by day, through sunset and twilight, to black at
  night.
- Stars, planets, constellation figures and deep-sky objects are drawn only when they could be seen: above the
  horizon and brighter than what the sky allows right now (twilight, moonlight and the extra air near the horizon all
  hide the fainter ones). The sun and moon are always shown when up.
- Satellites you track are always shown (faint when they can't be seen); other satellites only when visible.
  Aircraft are shown when an aircraft source is configured.
- On phones and tablets, the **Compass** button turns the dome so that its north points to real north (browsers allow
  this only when the page is opened over HTTPS; iOS asks for permission once).
- URL parameters: `?radius=30` (aircraft radius in nautical miles), `?heading=90` (a fixed direction at the top, e.g.
  for a wall screen facing east), `?figures=0` (no constellation figures),
  `?labels=0` (no names), `?at=22:00` (another time, within a week), `?instance=1`.
- The drawing code (`www/js/dome.js`) has no dependencies, so it can be embedded elsewhere, e.g. in an iframe on a
  dashboard.

**The flight map** shows the aircraft around home with their recent tracks, a one-minute heading line, altitude
colours, emergencies in red and lost contacts greyed, a choice of range, and (with the lightning module on) the strikes
of the last hour. Map tiles are optional: enter a tile server URL with `{z}`, `{x}` and `{y}` and the attribution its
provider requires (respect the provider's usage policy); without one the map shows range rings on a dark background.
The map uses [Leaflet](https://leafletjs.com/) (BSD-2-Clause, included in `www/lib/leaflet`).

Star positions: Yale Bright Star Catalogue (5th ed.), as converted by
[brettonw/YaleBrightStarCatalog](https://github.com/brettonw/YaleBrightStarCatalog) (MIT, Bretton Wade); constellation
figures: [d3-celestial](https://github.com/ofrohn/d3-celestial)
by Olaf Frohn (BSD-3-Clause). Both notices are in `www/js/skydata.js`.

### Notifications

Every alert is a state (`satellites.alert`, `aurora.alert`, `lightning.alert`, `aircraft.emergencyText`), so you can
build your own rules. Skyorama can also send them itself, set up on the **Notifications** tab:

- a table of messaging instances, each with the events it should receive (satellite pass, aurora, lightning,
  aircraft emergency) and an optional recipient;
- a **Send a test notification** button (uses the saved settings);
- per event, a cooldown (at most one message in that time) and quiet hours (no messages, in the ioBroker host's time);
- optionally, the ioBroker notification system as well (shown in Admin, and passed on by
  [notification-manager](https://github.com/foxriver76/ioBroker.notification-manager) to the messenger set up there).

Supported: pushover, telegram, email, signal-cmb, whatsapp-cmb, matrix-org, gotify, ntfy-client, pushsafer,
pushbullet, discord and synochat; each gets the message in the form it expects. Discord needs a recipient (a user ID,
a user name or `serverID/channelID`); for email the recipient is the address (otherwise the adapter's default), for
Telegram a user, for ntfy a topic. Aircraft emergencies are sent only with background aircraft polling on.

### States

| State | Description |
|---|---|
| `info.connection` | All data sources in use are reachable (false until the first successful fetch, and after two failed attempts in a row) |
| `info.celestrak` | CelesTrak reachable |
| `info.aircraftArea` / `info.aircraftLookup` / `info.aircraftLookup2` | The configured aircraft sources reachable (written once a source has been used) |
| `aircraft.count` | Aircraft within the background radius (background polling only, like all `aircraft.*` states) |
| `aircraft.overhead` | An airborne aircraft is at least the set angle above the horizon (default 45°) |
| `aircraft.nearest.*` | Nearest airborne aircraft: `callsign`, `type`, `registration`, `altitude` (ft), `distance` (km), `bearing` (°), `elevation` (°) |
| `aircraft.emergency` / `aircraft.emergencyText` | An aircraft is reporting an emergency (or squawking 7500, 7600 or 7700), and a description |
| `aircraft.list` | The aircraft within the background radius (JSON, same fields as the `aircraft` message) |
| `satellites.alert` | Alert text, written shortly before a visible pass of a chosen satellite |
| `satellites.tle` | The orbit set (JSON `{ at, groups, sats: [[name, line1, line2], …] }`) |
| `satellites.<satellite>.visibleNow` | The satellite is visible right now (`<satellite>` is `iss`, `tiangong`, or `n` and the catalogue number, e.g. `n20580` for the Hubble Space Telescope) |
| `satellites.<satellite>.passes` | Visible passes in the next 72 hours (JSON; passes already alerted are marked `alerted`) |
| `satellites.<satellite>.next.*` | The next visible pass: `start`, `end`, `maxEl`, `maxAt`, `fromAz`, `toAz`, `text` |
| `astronomy.darkness` | `day`, `civil`, `nautical`, `astronomical` or `night` |
| `astronomy.moon.*` | `phase`, `illumination` (%), `elevation` (°), next `rise` and `set` |
| `astronomy.planets.<name>.*` | `visible`, `elevation`, `azimuth`, next `rise` and `set`, `magnitude` |
| `astronomy.tonight` / `astronomy.tonightText` | Tonight's sky as JSON and as one line of text |
| `aurora.possible` | The aurora can be seen from home now (dark, near enough, not overcast) |
| `aurora.reason` / `aurora.summary` | Why or why not, and one line of text, e.g. "Unlikely from home: not dark" |
| `aurora.inputs` | Everything the decision used (JSON) |
| `aurora.alert` | Alert text, written when the aurora turns possible (at most every 6 hours) |
| `lightning.nearestKm` / `lightning.count1h` | Nearest strike (km) and number of strikes within the radius, last hour |
| `lightning.lastNearAt` | Time of the latest strike within the near radius |
| `lightning.strikes` | The newest strikes (up to 1000) within the radius in the last hour, updated at most once a minute (JSON `{ at, radiusKm, total, strikes: [{ lat, lon, t, km }] }`) |
| `lightning.alert` | Alert text for the first near strike after a quiet half hour |
| `info.noaa` / `info.openmeteo` / `info.aurorawatch` / `info.lightning` | Those sources reachable |

Times are timestamps in milliseconds. A value that does not exist (for example no next moonrise in the polar summer)
is `null`.

### Messages (sendTo)

Front-ends can ask the adapter directly. Every message gets an answer; errors come back as `{ error }`.

| Command | Message | Answer |
|---|---|---|
| `tle` | none | `{ at, groups, sats: [[name, line1, line2], …] }`, the orbit set for drawing satellites |
| `aircraft` | `{ radiusNm }` (1–250, default 40) | `{ at, radiusNm, ac: [...] }`, nearest first: `hex`, `flight`, `reg`, `type`, `lat`, `lon`, `alt` (ft, 0 = on the ground), `gs` (kn), `track`, `dst` (nm), `dir` (bearing from home), `vr` (ft/min), `selAlt`, `squawk`, `emergency`, `stale`, `trail` (`[[lat, lon, alt], …]`, the last 15 minutes) |
| `follow` | `{ hex }` | `{ at, found, ac }`: where the aircraft is now, wherever it is: `lat`, `lon`, `altGeom` (GNSS height, ft), `altBaro`, `gs`, `track`, `heading`, `roll`, `vr`, `seenPos`, `flight`, `reg`, `type`, `squawk`, `emergency`. Keep asking (every few seconds) while you follow it |
| `lookup` | `{ hex, flight, reg, lat, lon }` | `{ airline, route, photo }`: `route` = `{ from, to, fromName, toName, plausible, fromPos, toPos }` or null, `photo` = `{ src, link, by }` or null |

```js
sendTo('skyorama.0', 'aircraft', { radiusNm: 20 }, result => {
    if (result.error) return log(result.error, 'warn');
    for (const a of result.ac) log(`${a.flight || a.hex} at ${a.alt} ft, ${a.dst} nm`);
});
```

### Related adapters

- [JetFrame](https://github.com/backfisch88/ioBroker.jetframe) is a complete plane-spotting display: it shows the
  aircraft passing your window, with photos, runway detection and daily statistics in its own web app. Use it if that
  is what you want. Skyorama's aircraft module is a data source instead: states for automations and a `sendTo` API for
  your own dashboards and maps, next to the rest of the sky.
- [aurora-nowcast](https://github.com/chrmenne/ioBroker.aurora-nowcast) provides the aurora probability at your
  location, the Kp index and solar wind data. Skyorama's aurora module adds "can I see it from here now" (darkness,
  cloud, aurora low on the horizon) and uses aurora-nowcast's Kp when it is installed.

### Roadmap

VIS-2 widgets for the dome and the map.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) Satellites (ISS and Tiangong passes, pass alerts, orbit set) and astronomy (darkness, moon, planets, tonight's sky)
* (Alan Paris) Aircraft: nearby aircraft, following one aircraft and aircraft details for front-ends, optional background states
* (Alan Paris) Aurora (visible from home now?) and lightning nearby (Blitzortung)
* (Alan Paris) Optional sky dome page (www): the sky above home as you would see it, with aircraft and satellites
* (Alan Paris) Optional flight map page (www), and details for an aircraft or satellite on both pages
* (Alan Paris) Aircraft and lightning sources are configured by the user (URLs, optional API header, broker login); none built in
* (Alan Paris) Choose up to 20 satellites for passes and alerts (ISS and Tiangong by default)
* (Alan Paris) Notifications to messaging adapters and ioBroker notifications, with cooldown and quiet hours per event

## License
MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.