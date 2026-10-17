// The sky right now, for the dome visualisation (`sendTo sky`): sun, moon, planets and the satellites above the
// horizon. Stars and constellations are static data drawn by the page itself.

import * as Astro from 'astronomy-engine';
import * as sat from 'satellite.js';
import { PLANETS, bodyAltAz, sunAltitude } from './astronomy';
import { STATIONS, catalogueNumber, lookAt, nameOf, type Pass, type Tle } from './satellites';
import { round, type Location } from './util';

/** satellites are given now and this much later, so the page can move them smoothly between requests */
const AHEAD_MS = 10_000;
/** a satellite counts as visible: lit, at least this high, the sun this far below the horizon (as for passes) */
const VIS_EL = 10;
const SUN_EL = -6;

export interface SkySatellite {
    id: string;
    name: string;
    /** one of the satellites chosen in the settings */
    tracked: boolean;
    az: number;
    el: number;
    /** where it will be AHEAD_MS later */
    az2: number;
    el2: number;
    lit: boolean;
    visible: boolean;
    /** tracked satellites: their next visible pass, if any */
    nextPass?: { start: number; end: number; maxEl: number; maxAt: number };
}

export interface SkyNow {
    at: number;
    aheadMs: number;
    home: { lat: number; lon: number };
    sun: { az: number; el: number };
    moon: { az: number; el: number; phase: number; lit: number; mag: number };
    planets: { name: string; az: number; el: number; mag: number }[];
    satellites: SkySatellite[];
}

/** Parsed orbits, kept until the orbit set changes. */
export class SatrecCache {
    private key = '';
    private recs: { id: string; name: string; rec: sat.SatRec }[] = [];

    public get(tle: Tle[], at: number): { id: string; name: string; rec: sat.SatRec }[] {
        const key = `${at}:${tle.length}`;
        if (key !== this.key) {
            this.key = key;
            this.recs = [];
            for (const t of tle) {
                try {
                    const id = catalogueNumber(t[1]);
                    this.recs.push({ id, name: nameOf(id, t), rec: sat.twoline2satrec(t[1], t[2]) });
                } catch {
                    // a malformed element set is skipped
                }
            }
        }
        return this.recs;
    }
}

export function skyNow(
    home: Location,
    now: number,
    orbits: { id: string; name: string; rec: sat.SatRec }[],
    tracked: string[],
    passes: readonly Pass[] = [],
): SkyNow {
    const date = new Date(now);
    const sun = bodyAltAz(Astro.Body.Sun, home, now);
    const sunEl = sunAltitude(home, now);
    const moon = bodyAltAz(Astro.Body.Moon, home, now);
    const moonIll = Astro.Illumination(Astro.Body.Moon, date);
    const planets = Object.entries(PLANETS).map(([key, body]) => {
        const p = bodyAltAz(body, home, now);
        return {
            name: key.charAt(0).toUpperCase() + key.slice(1),
            az: round(p.az, 2),
            el: round(p.alt, 2),
            mag: round(Astro.Illumination(body, date).mag, 1),
        };
    });
    const stationIds = Object.values(STATIONS).map(s => s.id);
    const satellites: SkySatellite[] = [];
    for (const o of orbits) {
        const a = lookAt(o.rec, home, now);
        const b = lookAt(o.rec, home, now + AHEAD_MS);
        if (!a || !b || (a.el <= 0 && b.el <= 0)) {
            continue;
        }
        satellites.push({
            id: o.id,
            name: o.name,
            tracked: tracked.includes(o.id) || (tracked.length === 0 && stationIds.includes(o.id)),
            az: round(a.az, 2),
            el: round(a.el, 2),
            az2: round(b.az, 2),
            el2: round(b.el, 2),
            lit: a.lit,
            visible: a.lit && a.el >= VIS_EL && sunEl < SUN_EL,
        });
        const isTracked = satellites[satellites.length - 1].tracked;
        const next = isTracked ? passes.find(p => p.sat === o.name && p.end >= now) : undefined;
        if (next) {
            satellites[satellites.length - 1].nextPass = {
                start: next.start,
                end: next.end,
                maxEl: next.maxEl,
                maxAt: next.maxAt,
            };
        }
    }
    return {
        at: now,
        aheadMs: AHEAD_MS,
        home: { lat: home.lat, lon: home.lon },
        sun: { az: round(sun.az, 2), el: round(sun.alt, 2) },
        moon: {
            az: round(moon.az, 2),
            el: round(moon.alt, 2),
            phase: round(Astro.MoonPhase(date), 1),
            lit: round(moonIll.phase_fraction, 3),
            mag: round(moonIll.mag, 1),
        },
        planets,
        satellites,
    };
}
