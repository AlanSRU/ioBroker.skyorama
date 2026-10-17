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

- Positions come from the free community ADS-B feeds [adsb.lol](https://adsb.lol/) (aircraft around you) and
  [adsb.fi](https://adsb.fi/) (one aircraft wherever it is, at most one request a second), or from your own receiver
  ([readsb](https://github.com/wiedehopf/readsb), dump1090 or [tar1090](https://github.com/wiedehopf/tar1090)
  `aircraft.json`) if you enter its URL.
- Nothing is polled unless something needs it: a front-end asking through `sendTo` (every 10 seconds while asked, for
  the widest radius asked for in the last minute), or the optional background polling for the `aircraft.*` states.
- Details for one aircraft (route, photo, airline) come from the [VRS standing data](https://github.com/vradarserver/standing-data)
  and [planespotters.net](https://www.planespotters.net/) (photos are returned with the photographer's name and a link,
  as their terms ask). They are loaded only when asked for and cached (routes 1 day, photos 7 days).

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

Strikes from the [Blitzortung.org](https://www.blitzortung.org/) community lightning network, received through the
public MQTT feed run for Home Assistant's Blitzortung integration. The adapter subscribes only to the area around you
(the geohash cells that cover the configured radius). Off by default. Blitzortung data may be used for private,
non-commercial purposes only.

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

### Notifications

Every alert is a state (`satellites.alert`, `aurora.alert`, `lightning.alert`, `aircraft.emergencyText`), so you can
build your own rules. Skyorama can also send them itself, set up on the **Notifications** tab:

- a table of messaging instances, each with the events it should receive (satellite pass, aurora, lightning,
  aircraft emergency) and an optional recipient;
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
| `info.adsblol` / `info.adsbfi` / `info.receiver` | The aircraft feeds reachable (written once a feed has been used) |
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
| `info.noaa` / `info.openmeteo` / `info.aurorawatch` / `info.blitzortung` | Those sources reachable |

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

An optional overhead-dome and flight-map visualisation.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) Satellites (ISS and Tiangong passes, pass alerts, orbit set) and astronomy (darkness, moon, planets, tonight's sky)
* (Alan Paris) Aircraft: nearby aircraft, following one aircraft and aircraft details for front-ends, optional background states
* (Alan Paris) Aurora (visible from home now?) and lightning nearby (Blitzortung)
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