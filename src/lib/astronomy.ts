// Astronomy: darkness, moon, planets and "what's worth looking at tonight", from astronomy-engine (no network).

import * as Astro from 'astronomy-engine';
import { type Host } from './host';
import type { Pass } from './satellites';
import { clock, compass, round, type Location } from './util';

export type Darkness = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';

export const DARKNESS_LABELS: Record<Darkness, string> = {
    day: 'Day',
    civil: 'Civil twilight',
    nautical: 'Nautical twilight',
    astronomical: 'Astronomical twilight',
    night: 'Night',
};

/** The naked-eye planets; key = object id under `astronomy.planets.` */
export const PLANETS: Record<string, Astro.Body> = {
    mercury: Astro.Body.Mercury,
    venus: Astro.Body.Venus,
    mars: Astro.Body.Mars,
    jupiter: Astro.Body.Jupiter,
    saturn: Astro.Body.Saturn,
};

/** Bright deep-sky objects (J2000 RA in hours, Dec in degrees), north and south. */
export const DEEP_SKY: { name: string; ra: number; dec: number }[] = [
    { name: 'Andromeda Galaxy', ra: 0.712, dec: 41.27 },
    { name: 'Orion Nebula', ra: 5.588, dec: -5.39 },
    { name: 'Pleiades', ra: 3.79, dec: 24.12 },
    { name: 'Double Cluster', ra: 2.35, dec: 57.13 },
    { name: 'Hercules Cluster', ra: 16.695, dec: 36.46 },
    { name: 'Beehive Cluster', ra: 8.67, dec: 19.98 },
    { name: 'Ring Nebula', ra: 18.893, dec: 33.03 },
    { name: 'Lagoon Nebula', ra: 18.06, dec: -24.38 },
    { name: 'Omega Centauri', ra: 13.447, dec: -47.48 },
    { name: 'Large Magellanic Cloud', ra: 5.393, dec: -69.76 },
    { name: 'Small Magellanic Cloud', ra: 0.877, dec: -72.83 },
];

/** A planet counts as visible when at least this high and the sun below DARK_SUN. */
const PLANET_MIN_EL = 5;
/** "After dark": the sun below −6° (end of civil twilight). */
const DARK_SUN = -6;
/** Tonight's lists: planets that get this high, deep-sky objects that get this high ("well placed"). */
const TONIGHT_PLANET_EL = 10;
const TONIGHT_DEEP_SKY_EL = 30;
const SAMPLE_MS = 10 * 60_000;

function observer(home: Location): Astro.Observer {
    return new Astro.Observer(home.lat, home.lon, home.height);
}

/**
 * Altitude/azimuth of a solar-system body (degrees, with refraction).
 */
export function bodyAltAz(body: Astro.Body, home: Location, t: number): { alt: number; az: number } {
    const obs = observer(home);
    const date = new Date(t);
    const eq = Astro.Equator(body, date, obs, true, true);
    const h = Astro.Horizon(date, obs, eq.ra, eq.dec, 'normal');
    return { alt: h.altitude, az: h.azimuth };
}

/** Geometric altitude of the sun's centre (no refraction): the twilight thresholds are defined that way. */
export function sunAltitude(home: Location, t: number): number {
    const obs = observer(home);
    const date = new Date(t);
    const eq = Astro.Equator(Astro.Body.Sun, date, obs, true, true);
    return Astro.Horizon(date, obs, eq.ra, eq.dec).altitude;
}

/**
 * Sun altitude → darkness. "day" ends when the sun's upper edge sets (−0.833° with refraction).
 */
export function darkness(sunAlt: number): Darkness {
    if (sunAlt > -0.833) {
        return 'day';
    }
    if (sunAlt > -6) {
        return 'civil';
    }
    if (sunAlt > -12) {
        return 'nautical';
    }
    if (sunAlt > -18) {
        return 'astronomical';
    }
    return 'night';
}

const PHASES = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
];

/**
 * Moon phase angle (0 = new, 90 = first quarter, 180 = full, 270 = last quarter) → name.
 */
export function moonPhaseName(angle: number): string {
    return PHASES[Math.round((((angle % 360) + 360) % 360) / 45) % 8];
}

/**
 * Next rise and next set after `t` (ms), null when there is none within 2 days (polar day/night).
 */
export function nextRiseSet(body: Astro.Body, home: Location, t: number): { rise: number | null; set: number | null } {
    const obs = observer(home);
    const date = new Date(t);
    return {
        rise: Astro.SearchRiseSet(body, obs, +1, date, 2)?.date.getTime() ?? null,
        set: Astro.SearchRiseSet(body, obs, -1, date, 2)?.date.getTime() ?? null,
    };
}

/**
 * The coming (or current) dark period: sun below −6°. null when the sun doesn't get that low in the next day.
 */
export function darkWindow(home: Location, now: number): { from: number; to: number } | null {
    const obs = observer(home);
    let from = now;
    if (sunAltitude(home, now) >= DARK_SUN) {
        const dusk = Astro.SearchAltitude(Astro.Body.Sun, obs, -1, new Date(now), 1, DARK_SUN);
        if (!dusk) {
            return null;
        }
        from = dusk.date.getTime();
    }
    const dawn = Astro.SearchAltitude(Astro.Body.Sun, obs, +1, new Date(from), 2, DARK_SUN);
    // Polar night: cap the window at a day.
    return { from, to: dawn ? dawn.date.getTime() : from + 24 * 3600_000 };
}

interface Best {
    name: string;
    from: number;
    maxEl: number;
    maxAt: number;
    maxAz: number;
}

export interface Tonight {
    at: number;
    dark: {
        from: number;
        to: number;
    } | null;
    planets: (Best & {
        magnitude: number;
    })[];
    moon: {
        phase: string;
        illumination: number;
        rise: number | null;
        set: number | null;
        maxEl: number;
    } | null;
    passes: {
        sat: string;
        start: number;
        maxEl: number;
        fromAz: number;
        toAz: number;
    }[];
    deepSky: Best[];
    text: string;
}

/**
 * Highest point of something over the dark window, sampled every 10 min.
 */
function best(
    name: string,
    times: number[],
    altAz: (t: number) => { alt: number; az: number },
    minEl: number,
): Best | null {
    let b: Best | null = null;
    for (const t of times) {
        const p = altAz(t);
        if (p.alt < minEl) {
            continue;
        }
        b ??= { name, from: t, maxEl: p.alt, maxAt: t, maxAz: p.az };
        if (p.alt > b.maxEl) {
            Object.assign(b, { maxEl: p.alt, maxAt: t, maxAz: p.az });
        }
    }
    return b && { ...b, maxEl: round(b.maxEl), maxAz: round(b.maxAz) };
}

export function tonight(home: Location, now: number, passes: readonly Pass[]): Tonight {
    const dark = darkWindow(home, now);
    if (!dark) {
        return { at: now, dark: null, planets: [], moon: null, passes: [], deepSky: [], text: 'No darkness tonight.' };
    }
    const times: number[] = [];
    for (let t = dark.from; t <= Math.min(dark.to, dark.from + 18 * 3600_000); t += SAMPLE_MS) {
        times.push(t);
    }
    const obs = observer(home);

    const planets: Tonight['planets'] = [];
    for (const [key, body] of Object.entries(PLANETS)) {
        const b = best(cap(key), times, t => bodyAltAz(body, home, t), TONIGHT_PLANET_EL);
        if (b) {
            planets.push({ ...b, magnitude: round(Astro.Illumination(body, new Date(b.maxAt)).mag, 1) });
        }
    }

    const moonBest = best('Moon', times, t => bodyAltAz(Astro.Body.Moon, home, t), 0);
    const inDark = (t: number | null): number | null => (t !== null && t >= dark.from && t <= dark.to ? t : null);
    const moon = moonBest && {
        phase: moonPhaseName(Astro.MoonPhase(new Date(moonBest.maxAt))),
        illumination: round(Astro.Illumination(Astro.Body.Moon, new Date(moonBest.maxAt)).phase_fraction * 100),
        rise: inDark(Astro.SearchRiseSet(Astro.Body.Moon, obs, +1, new Date(dark.from), 1)?.date.getTime() ?? null),
        set: inDark(Astro.SearchRiseSet(Astro.Body.Moon, obs, -1, new Date(dark.from), 1)?.date.getTime() ?? null),
        maxEl: moonBest.maxEl,
    };

    const deepSky = DEEP_SKY.map(o =>
        best(
            o.name,
            times,
            t => {
                const h = Astro.Horizon(new Date(t), obs, o.ra, o.dec, 'normal');
                return { alt: h.altitude, az: h.azimuth };
            },
            TONIGHT_DEEP_SKY_EL,
        ),
    ).filter((b): b is Best => b !== null);

    const tonightPasses = passes
        .filter(p => p.start >= dark.from && p.start <= dark.to)
        .map(p => ({
            sat: p.sat,
            start: p.start,
            maxEl: round(p.maxEl),
            fromAz: round(p.fromAz),
            toAz: round(p.toAz),
        }));

    const result: Tonight = { at: now, dark, planets, moon, passes: tonightPasses, deepSky, text: '' };
    result.text = tonightText(result, now);
    return result;
}

export function tonightText(n: Tonight, now: number): string {
    if (!n.dark) {
        return 'No darkness tonight.';
    }
    const parts = [`Dark from ${clock(n.dark.from, now)} to ${clock(n.dark.to, now)}.`];
    if (n.planets.length) {
        parts.push(
            `Planets: ${n.planets
                .map(
                    p =>
                        `${p.name} (highest ${p.maxEl}° in the ${compass(p.maxAz)} at ${clock(p.maxAt, now).slice(-5)})`,
                )
                .join(', ')}.`,
        );
    }
    if (n.moon) {
        const when = [
            n.moon.rise && `rises ${clock(n.moon.rise, now).slice(-5)}`,
            n.moon.set && `sets ${clock(n.moon.set, now).slice(-5)}`,
        ]
            .filter(Boolean)
            .join(', ');
        parts.push(`Moon: ${n.moon.phase}, ${n.moon.illumination} % lit${when ? `, ${when}` : ''}.`);
    } else {
        parts.push('Moon: not up.');
    }
    if (n.passes.length) {
        parts.push(
            `Satellite passes: ${n.passes.map(p => `${p.sat} ${clock(p.start, now).slice(-5)} (${p.maxEl}°)`).join(', ')}.`,
        );
    }
    if (n.deepSky.length) {
        parts.push(`Deep sky: ${n.deepSky.map(d => d.name).join(', ')}.`);
    }
    return parts.join(' ');
}

function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Runs the module: sky facts every minute, tonight's summary every 10 minutes and when passes change. */
export class AstronomyModule {
    private tickTimer: ioBroker.Interval | undefined;
    private lastTonight = 0;

    public constructor(
        private readonly host: Host,
        private readonly getPasses: () => readonly Pass[],
        private readonly extraLines: () => string[] = () => [],
    ) {}

    public async start(): Promise<void> {
        await this.tick();
        this.tickTimer = this.host.adapter.setInterval(() => void this.tick(), 60_000);
    }

    public stop(): void {
        this.host.adapter.clearInterval(this.tickTimer);
    }

    /** Recompute tonight's summary now (new passes). */
    public async refreshTonight(): Promise<void> {
        const n = tonight(this.host.home, Date.now(), this.getPasses());
        const extra = this.extraLines();
        if (n.dark && extra.length) {
            n.text += ` ${extra.map(l => `${l}.`).join(' ')}`;
        }
        this.lastTonight = n.at;
        await this.host.write('astronomy.tonight', JSON.stringify(n));
        await this.host.write('astronomy.tonightText', n.text);
    }

    private async tick(): Promise<void> {
        const home = this.host.home;
        const now = Date.now();
        const sunAlt = sunAltitude(home, now);
        await this.host.write('astronomy.darkness', darkness(sunAlt));

        const moon = bodyAltAz(Astro.Body.Moon, home, now);
        const moonRs = nextRiseSet(Astro.Body.Moon, home, now);
        await this.host.write('astronomy.moon.phase', moonPhaseName(Astro.MoonPhase(new Date(now))));
        await this.host.write(
            'astronomy.moon.illumination',
            round(Astro.Illumination(Astro.Body.Moon, new Date(now)).phase_fraction * 100),
        );
        await this.host.write('astronomy.moon.elevation', round(moon.alt, 1));
        await this.host.write('astronomy.moon.rise', moonRs.rise);
        await this.host.write('astronomy.moon.set', moonRs.set);

        for (const [key, body] of Object.entries(PLANETS)) {
            const p = bodyAltAz(body, home, now);
            const rs = nextRiseSet(body, home, now);
            const id = `astronomy.planets.${key}`;
            await this.host.write(`${id}.visible`, p.alt >= PLANET_MIN_EL && sunAlt < DARK_SUN);
            await this.host.write(`${id}.elevation`, round(p.alt, 1));
            await this.host.write(`${id}.azimuth`, round(p.az, 1));
            await this.host.write(`${id}.rise`, rs.rise);
            await this.host.write(`${id}.set`, rs.set);
            await this.host.write(`${id}.magnitude`, round(Astro.Illumination(body, new Date(now)).mag, 1));
            if (this.host.stopped()) {
                return;
            }
        }

        if (now - this.lastTonight >= 10 * 60_000) {
            await this.refreshTonight();
        }
    }
}
