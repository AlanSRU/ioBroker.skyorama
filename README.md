![Logo](admin/skyorama.png)
# ioBroker.skyorama

[![NPM version](https://img.shields.io/npm/v/iobroker.skyorama.svg)](https://www.npmjs.com/package/iobroker.skyorama)
[![Downloads](https://img.shields.io/npm/dm/iobroker.skyorama.svg)](https://www.npmjs.com/package/iobroker.skyorama)
![Number of Installations](https://iobroker.live/badges/skyorama-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/skyorama-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.skyorama.png?downloads=true)](https://nodei.co/npm/iobroker.skyorama/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.skyorama/workflows/Test%20and%20Release/badge.svg)

## Skyorama adapter for ioBroker

What is in the sky over your location, as ioBroker states for automations, dashboards and alerts: the visible passes
of the space stations, the moon and planets, how dark it is and what is worth looking at tonight.

Skyorama works anywhere: it uses the latitude and longitude from the ioBroker system settings (or a location entered
in the instance settings). Requires Node.js 22 or newer.

### Modules

Each module can be switched on or off in the instance settings. Switching a module off keeps its objects.

#### Satellites

- Orbits come from [CelesTrak](https://celestrak.org/), fetched at most twice a day at a random time (CelesTrak blocks
  addresses that fetch the same data more often than every 2 hours). The last orbit set is kept, so a restart does not
  cause a new fetch. A change to the CelesTrak groups in the settings takes effect at most 2 hours after the last fetch.
- Visible passes of the **ISS** and **Tiangong** over your location are worked out for the next 72 hours. A pass counts as
  visible when the station is lit by the sun, at least 10° above the horizon, and the sun at your location is more
  than 6° below the horizon.
- An alert text is written a set time before each visible pass that gets high enough (defaults: 10 minutes, 20°).

#### Astronomy

Calculated locally with [Astronomy Engine](https://github.com/cosinekitty/astronomy), no internet access: the
darkness (day, civil / nautical / astronomical twilight, night), the moon, the five naked-eye planets, and a summary
of tonight's sky: when it is dark, which planets are up, the moon, space station passes, and bright deep-sky objects
that are well placed (for example the Andromeda Galaxy, the Pleiades or the Orion Nebula; in the southern hemisphere
also Omega Centauri and the Magellanic Clouds).

### States

| State | Description |
|---|---|
| `info.connection` | All data sources in use are reachable (false until the first successful fetch, and after two failed attempts in a row) |
| `info.celestrak` | CelesTrak reachable |
| `satellites.alert` | Alert text, written shortly before a visible space station pass |
| `satellites.tle` | The orbit set (JSON `{ at, groups, sats: [[name, line1, line2], …] }`) |
| `satellites.<iss\|tiangong>.visibleNow` | The station is visible right now |
| `satellites.<iss\|tiangong>.passes` | Visible passes in the next 72 hours (JSON) |
| `satellites.<iss\|tiangong>.next.*` | The next visible pass: `start`, `end`, `maxEl`, `maxAt`, `fromAz`, `toAz`, `text` |
| `astronomy.darkness` | `day`, `civil`, `nautical`, `astronomical` or `night` |
| `astronomy.moon.*` | `phase`, `illumination` (%), `elevation` (°), next `rise` and `set` |
| `astronomy.planets.<name>.*` | `visible`, `elevation`, `azimuth`, next `rise` and `set`, `magnitude` |
| `astronomy.tonight` / `astronomy.tonightText` | Tonight's sky as JSON and as one line of text |

Times are timestamps in milliseconds. A value that does not exist (for example no next moonrise in the polar summer)
is `null`.

### Messages (sendTo)

Front-ends can ask the adapter directly. Every message gets an answer; errors come back as `{ error }`.

| Command | Message | Answer |
|---|---|---|
| `tle` | none | `{ at, groups, sats: [[name, line1, line2], …] }`, the orbit set for drawing satellites |

```js
sendTo('skyorama.0', 'tle', {}, result => {
    log(`${result.sats.length} orbits from ${new Date(result.at)}`);
});
```

### Roadmap

Aircraft overhead (ADS-B), the chance of seeing the aurora, nearby lightning, notifications to messaging adapters,
and an optional overhead-dome and flight-map visualisation.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) Satellites (ISS and Tiangong passes, pass alerts, orbit set) and astronomy (darkness, moon, planets, tonight's sky)

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