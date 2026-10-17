// Sky extras: meteor showers, eclipses seen from home, moon and planet events of the next 30 days, and a stargazing
// forecast for tonight (Open-Meteo cloud by height). Everything but the forecast is calculated locally.

import * as Astro from 'astronomy-engine';
import { PLANETS, bodyAltAz, darkWindow, sunAltitude } from './astronomy';
import { SourceHealth } from './health';
import type { Host } from './host';
import { getJson, type JsonFetcher } from './http';
import { clock, num, round, type Location } from './util';

const DAY = 86400_000;
const RAD = Math.PI / 180;

/** "Sat 21 Sep" in the system's time zone. */
const day = (t: number): string =>
    new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// --- meteor showers ---------------------------------------------------------------------------------------------------

/**
 * The major annual showers (IMO working list): peak at the sun's ecliptic longitude `peakLon` (J2000), zenithal hourly
 * rate at the peak, radiant (RA hours, Dec degrees), active window (month-day, may wrap the year).
 */
export const SHOWERS: {
    code: string;
    name: string;
    peakLon: number;
    zhr: number;
    ra: number;
    dec: number;
    from: string;
    to: string;
}[] = [
    { code: 'QUA', name: 'Quadrantids', peakLon: 283.15, zhr: 110, ra: 15.33, dec: 49, from: '12-28', to: '01-12' },
    { code: 'LYR', name: 'Lyrids', peakLon: 32.32, zhr: 18, ra: 18.07, dec: 34, from: '04-14', to: '04-30' },
    { code: 'ETA', name: 'Eta Aquariids', peakLon: 45.5, zhr: 50, ra: 22.53, dec: -1, from: '04-19', to: '05-28' },
    {
        code: 'SDA',
        name: 'Southern Delta Aquariids',
        peakLon: 127,
        zhr: 25,
        ra: 22.67,
        dec: -16,
        from: '07-12',
        to: '08-23',
    },
    { code: 'PER', name: 'Perseids', peakLon: 140.0, zhr: 100, ra: 3.2, dec: 58, from: '07-17', to: '08-24' },
    { code: 'ORI', name: 'Orionids', peakLon: 208, zhr: 20, ra: 6.33, dec: 16, from: '10-02', to: '11-07' },
    { code: 'LEO', name: 'Leonids', peakLon: 235.27, zhr: 15, ra: 10.13, dec: 22, from: '11-06', to: '11-30' },
    { code: 'GEM', name: 'Geminids', peakLon: 262.2, zhr: 150, ra: 7.47, dec: 33, from: '12-04', to: '12-20' },
    { code: 'URS', name: 'Ursids', peakLon: 270.7, zhr: 10, ra: 14.47, dec: 75, from: '12-17', to: '12-26' },
];

/** The shower is in its active window on this date (month-day, wrapping the year end). */
export function inWindow(t: number, from: string, to: string): boolean {
    const d = new Date(t);
    const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/** A J2000 solar longitude as the equinox-of-date longitude astronomy-engine searches for (precession, 50″ a year). */
function ofDate(lonJ2000: number, t: number): number {
    return (lonJ2000 + (1.397 * (t - Date.UTC(2000, 0, 1, 12))) / (36525 * DAY)) % 360;
}

/** The next time the sun reaches a J2000 longitude, after `t`. */
function sunAt(lonJ2000: number, t: number): number | null {
    // month by month: over a long window the search can step past the nearer crossing to the next year's
    for (let from = t; from < t + 370 * DAY; from += 30 * DAY) {
        const found = Astro.SearchSunLongitude(ofDate(lonJ2000, from), new Date(from), 31);
        if (found) {
            return found.date.getTime();
        }
    }
    return null;
}

/** The peak nearest to `t` (within half a year). */
export function nearestPeak(peakLon: number, t: number): number {
    const a = sunAt(peakLon, t) ?? Infinity;
    const b = sunAt(peakLon, t - 366 * DAY) ?? -Infinity;
    return Math.abs(a - t) < Math.abs(t - b) ? a : b;
}

/** Observed hourly rate: ZHR, less away from the peak, the radiant's height, and the faintest visible star. */
export function hourlyRate(zhr: number, daysFromPeak: number, radiantEl: number, limitingMag: number): number {
    if (radiantEl <= 0) {
        return 0;
    }
    // activity falls about tenfold every 4 days from the peak; population index r ≈ 2.2
    const activity = zhr * 10 ** (-Math.abs(daysFromPeak) / 4);
    return activity * Math.sin(radiantEl * RAD) * 2.2 ** (limitingMag - 6.5);
}

/** The faintest star visible from a suburban garden (6.0), less for the moon when it is up. */
function limitingMag(home: Location, t: number): number {
    const moon = bodyAltAz(Astro.Body.Moon, home, t);
    const lit = Astro.Illumination(Astro.Body.Moon, new Date(t)).phase_fraction;
    return moon.alt > -2 ? 6.0 - 1.8 * lit * Math.min(1, (moon.alt + 2) / 30) : 6.0;
}

export interface MeteorInfo {
    active: { code: string; name: string; peak: number; zhr: number; rateTonight: number; bestAt: number | null }[];
    next: { code: string; name: string; peak: number; zhr: number } | null;
    text: string;
}

export function meteorShowers(home: Location, now: number): MeteorInfo {
    const dark = darkWindow(home, now);
    const active: MeteorInfo['active'] = [];
    for (const s of SHOWERS) {
        if (!inWindow(now, s.from, s.to)) {
            continue;
        }
        const peak = nearestPeak(s.peakLon, now);
        let best = 0;
        let bestAt: number | null = null;
        if (dark) {
            const obs = new Astro.Observer(home.lat, home.lon, home.height);
            for (let t = dark.from; t <= Math.min(dark.to, dark.from + 18 * 3600_000); t += 1800_000) {
                const h = Astro.Horizon(new Date(t), obs, s.ra, s.dec).altitude;
                const r = hourlyRate(s.zhr, (t - peak) / DAY, h, limitingMag(home, t));
                if (r > best) {
                    best = r;
                    bestAt = t;
                }
            }
        }
        active.push({ code: s.code, name: s.name, peak, zhr: s.zhr, rateTonight: Math.round(best), bestAt });
    }
    let next: MeteorInfo['next'] = null;
    for (const s of SHOWERS) {
        if (active.some(a => a.code === s.code)) {
            continue;
        }
        const peak = sunAt(s.peakLon, now);
        if (peak !== null && peak > now && (!next || peak < next.peak)) {
            next = { code: s.code, name: s.name, peak, zhr: s.zhr };
        }
    }
    const parts = active.map(
        a =>
            `${a.name} active (peak ${day(a.peak)})${a.rateTonight > 0 ? `, up to ${a.rateTonight} per hour tonight` : ''}`,
    );
    if (!active.length && next) {
        parts.push(`Next meteor shower: ${next.name}, peak ${day(next.peak)}`);
    }
    return { active, next, text: parts.join('; ') };
}

// --- eclipses ---------------------------------------------------------------------------------------------------------

export interface EclipseInfo {
    solar: { kind: string; start: number; peak: number; end: number; obscuration: number; altitude: number } | null;
    lunar: { kind: string; peak: number; obscuration: number; partialMinutes: number } | null;
    text: string;
}

/** The next solar and lunar eclipses that can be seen from home (sun or moon up at the peak; no penumbral ones). */
export function eclipses(home: Location, now: number): EclipseInfo {
    const obs = new Astro.Observer(home.lat, home.lon, home.height);
    let solar: EclipseInfo['solar'] = null;
    try {
        let e = Astro.SearchLocalSolarEclipse(new Date(now), obs);
        for (let i = 0; i < 40 && !solar; i++) {
            if (e.peak.altitude > 0) {
                solar = {
                    kind: e.kind,
                    start: e.partial_begin.time.date.getTime(),
                    peak: e.peak.time.date.getTime(),
                    end: e.partial_end.time.date.getTime(),
                    obscuration: round(e.obscuration * 100),
                    altitude: round(e.peak.altitude),
                };
            } else {
                e = Astro.NextLocalSolarEclipse(e.peak.time, obs);
            }
        }
    } catch {
        solar = null;
    }
    let lunar: EclipseInfo['lunar'] = null;
    let l = Astro.SearchLunarEclipse(new Date(now));
    for (let i = 0; i < 40 && !lunar; i++) {
        const peak = l.peak.date.getTime();
        if (l.kind !== Astro.EclipseKind.Penumbral && bodyAltAz(Astro.Body.Moon, home, peak).alt > 0) {
            lunar = {
                kind: l.kind,
                peak,
                obscuration: round(l.obscuration * 100),
                partialMinutes: round(l.sd_partial * 2),
            };
        } else {
            l = Astro.NextLunarEclipse(l.peak);
        }
    }
    const date = (t: number): string =>
        new Date(t).toLocaleString('en-GB', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    const parts: string[] = [];
    if (solar) {
        parts.push(
            `Next solar eclipse seen from here: ${solar.kind}, ${date(solar.peak)}, ${solar.obscuration} % of the sun covered`,
        );
    }
    if (lunar) {
        parts.push(`Next lunar eclipse seen from here: ${lunar.kind}, ${date(lunar.peak)}`);
    }
    return { solar, lunar, text: parts.join('. ') };
}

// --- moon and planet events -------------------------------------------------------------------------------------------

export interface SkyEvent {
    at: number;
    type: 'moonPhase' | 'supermoon' | 'conjunction' | 'opposition' | 'elongation';
    text: string;
}

const QUARTERS = ['New moon', 'First quarter', 'Full moon', 'Last quarter'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Angle between two bodies as seen from home, degrees. */
function separation(home: Location, a: Astro.Body, b: Astro.Body, t: number): number {
    const obs = new Astro.Observer(home.lat, home.lon, home.height);
    const date = new Date(t);
    const ea = Astro.Equator(a, date, obs, true, true);
    const eb = Astro.Equator(b, date, obs, true, true);
    return Astro.AngleBetween(ea.vec, eb.vec);
}

/** Close approaches (local minima below `maxDeg`), sampled every 2 hours. */
function closeApproaches(
    home: Location,
    a: Astro.Body,
    b: Astro.Body,
    from: number,
    to: number,
    maxDeg: number,
): { at: number; deg: number }[] {
    const step = 2 * 3600_000;
    const out: { at: number; deg: number }[] = [];
    let prev2 = separation(home, a, b, from - step);
    let prev = separation(home, a, b, from);
    for (let t = from + step; t <= to; t += step) {
        const cur = separation(home, a, b, t);
        if (prev < prev2 && prev <= cur && prev < maxDeg) {
            out.push({ at: t - step, deg: prev });
        }
        prev2 = prev;
        prev = cur;
    }
    return out;
}

export function skyEvents(home: Location, now: number, days = 30): SkyEvent[] {
    const until = now + days * DAY;
    const events: SkyEvent[] = [];
    // moon phases, and a supermoon: a full moon within a day of a close perigee
    const perigees: number[] = [];
    let ap = Astro.SearchLunarApsis(new Date(now - 2 * DAY));
    for (let i = 0; i < 6 && ap.time.date.getTime() < until + 2 * DAY; i++) {
        if (ap.kind === Astro.ApsisKind.Pericenter && ap.dist_km < 362_000) {
            perigees.push(ap.time.date.getTime());
        }
        ap = Astro.NextLunarApsis(ap);
    }
    let q = Astro.SearchMoonQuarter(new Date(now));
    while (q.time.date.getTime() < until) {
        const at = q.time.date.getTime();
        const supermoon = q.quarter === 2 && perigees.some(p => Math.abs(p - at) < 1.5 * DAY);
        events.push({
            at,
            type: supermoon ? 'supermoon' : 'moonPhase',
            text: supermoon ? 'Full moon (supermoon)' : QUARTERS[q.quarter],
        });
        q = Astro.NextMoonQuarter(q);
    }
    // oppositions of the outer planets, greatest elongations of Mercury and Venus
    for (const body of [Astro.Body.Mars, Astro.Body.Jupiter, Astro.Body.Saturn]) {
        const t = Astro.SearchRelativeLongitude(body, 0, new Date(now)).date.getTime();
        if (t < until) {
            events.push({ at: t, type: 'opposition', text: `${body} at opposition (best seen all night)` });
        }
    }
    for (const body of [Astro.Body.Mercury, Astro.Body.Venus]) {
        const e = Astro.SearchMaxElongation(body, new Date(now));
        const t = e.time.date.getTime();
        if (t < until) {
            events.push({
                at: t,
                type: 'elongation',
                text: `${body} at greatest ${e.visibility} elongation (${Math.round(e.elongation)}° from the sun)`,
            });
        }
    }
    // the moon close to a planet, and planets close together
    const planets = Object.values(PLANETS);
    for (const p of planets) {
        for (const c of closeApproaches(home, Astro.Body.Moon, p, now, until, 4)) {
            events.push({ at: c.at, type: 'conjunction', text: `Moon ${c.deg.toFixed(1)}° from ${p}` });
        }
    }
    for (let i = 0; i < planets.length; i++) {
        for (let j = i + 1; j < planets.length; j++) {
            for (const c of closeApproaches(home, planets[i], planets[j], now, until, 2)) {
                events.push({
                    at: c.at,
                    type: 'conjunction',
                    text: `${planets[i]} ${c.deg.toFixed(1)}° from ${planets[j]}`,
                });
            }
        }
    }
    return events.sort((a, b) => a.at - b.at).map(e => ({ ...e, text: cap(e.text) }));
}

// --- tonight as a timeline -------------------------------------------------------------------------------------------

export interface NightTimeline {
    from: number;
    to: number;
    /** sample spacing, ms */
    step: number;
    /** altitudes in degrees, one per sample */
    sun: number[];
    moon: number[];
    planets: { key: string; name: string; alt: number[] }[];
}

/**
 * Altitudes every 10 minutes from half an hour before tonight's sunset to half an hour after sunrise (the night under
 * way, when it is dark now). Without a sunset or sunrise (polar day or night): the next 18 hours.
 */
export function nightTimeline(home: Location, now: number): NightTimeline {
    const obs = new Astro.Observer(home.lat, home.lon, home.height);
    const start = sunAltitude(home, now) < 0 ? now - 16 * 3600_000 : now;
    const set = Astro.SearchRiseSet(Astro.Body.Sun, obs, -1, new Date(start), 1);
    const rise = set && Astro.SearchRiseSet(Astro.Body.Sun, obs, +1, set.date, 1);
    const step = 600_000;
    let from = set && rise ? set.date.getTime() - 1800_000 : now;
    const to = set && rise ? rise.date.getTime() + 1800_000 : now + 18 * 3600_000;
    from -= from % step;
    const times: number[] = [];
    for (let t = from; t <= to; t += step) {
        times.push(t);
    }
    const alt = (body: Astro.Body): number[] => times.map(t => round(bodyAltAz(body, home, t).alt, 1));
    return {
        from,
        to,
        step,
        sun: times.map(t => round(sunAltitude(home, t), 1)),
        moon: alt(Astro.Body.Moon),
        planets: Object.entries(PLANETS).map(([key, body]) => ({ key, name: String(body), alt: alt(body) })),
    };
}

// --- stargazing forecast ----------------------------------------------------------------------------------------------

export interface ForecastHour {
    t: number;
    cloud: number;
    low: number;
    mid: number;
    high: number;
    /** the sun more than 12° down */
    dark: boolean;
    /** 0 (no use) … 100 (clear and moonless) */
    score: number;
}

/** Open-Meteo hourly answer (unixtime) → hours. */
export function forecastHours(data: unknown, home: Location): ForecastHour[] {
    const h = (data as { hourly?: Record<string, unknown[]> } | null)?.hourly;
    if (!h || !Array.isArray(h.time)) {
        return [];
    }
    const out: ForecastHour[] = [];
    h.time.forEach((s, i) => {
        const t = num(s);
        const cloud = num(h.cloud_cover?.[i]);
        if (t === null || cloud === null) {
            return;
        }
        const ms = t * 1000;
        const dark = sunAltitude(home, ms) < -12;
        const moon = bodyAltAz(Astro.Body.Moon, home, ms);
        const lit = Astro.Illumination(Astro.Body.Moon, new Date(ms)).phase_fraction;
        const moonPenalty = moon.alt > 0 ? 0.5 * lit : 0;
        out.push({
            t: ms,
            cloud,
            low: num(h.cloud_cover_low?.[i]) ?? 0,
            mid: num(h.cloud_cover_mid?.[i]) ?? 0,
            high: num(h.cloud_cover_high?.[i]) ?? 0,
            dark,
            score: dark ? Math.round((100 - cloud) * (1 - moonPenalty)) : 0,
        });
    });
    return out;
}

/** Tonight's best stretch: consecutive dark hours with under 30 % cloud. */
export function bestHours(hours: ForecastHour[], home: Location, now: number): string {
    const dark = darkWindow(home, now);
    if (!dark) {
        return 'Not dark tonight';
    }
    const tonight = hours.filter(h => h.dark && h.t >= dark.from - 3600_000 && h.t <= dark.to);
    if (!tonight.length) {
        return '';
    }
    let best: ForecastHour[] = [];
    let run: ForecastHour[] = [];
    for (const h of tonight) {
        run = h.cloud < 30 ? [...run, h] : [];
        if (run.length > best.length) {
            best = run;
        }
    }
    if (!best.length) {
        const min = Math.min(...tonight.map(h => h.cloud));
        return `Cloudy tonight (at least ${Math.round(min)} % cloud)`;
    }
    const avg = Math.round(best.reduce((s, h) => s + h.cloud, 0) / best.length);
    const hm = (t: number): string => clock(t, now).slice(-5);
    return `Best for stargazing tonight: ${hm(best[0].t)}–${hm(best[best.length - 1].t + 3600_000)}, about ${avg} % cloud`;
}

/** Runs the extras: events, eclipses and meteors hourly; the forecast every 2 hours (optional). */
export class SkyExtrasModule {
    public readonly health: SourceHealth | null;
    private timer: ioBroker.Timeout | undefined;
    private nextForecast = 0;
    private hours: ForecastHour[] = [];
    private meteorText = '';
    /** The latest results, for the "upcoming" page. */
    public latest: { meteors: MeteorInfo | null; eclipses: EclipseInfo | null; events: SkyEvent[] } = {
        meteors: null,
        eclipses: null,
        events: [],
    };

    /** `onChange`: new lines for tonight's summary (the astronomy module rewrites it). */
    public constructor(
        private readonly host: Host,
        forecast: boolean,
        private readonly onChange: () => void = () => undefined,
        private readonly fetchJson: JsonFetcher = getJson,
    ) {
        this.health = forecast ? new SourceHealth('Open-Meteo forecast', host.log, 'forecast') : null;
        // spread the load: a random first forecast within a few minutes
        this.nextForecast = Date.now() + 10_000 + Math.floor(Math.random() * 120_000);
    }

    /** Lines for tonight's summary. */
    public get tonightLines(): string[] {
        return [this.meteorText, this.health ? bestHours(this.hours, this.host.home, Date.now()) : ''].filter(Boolean);
    }

    /** Tonight's forecast hours (empty while the forecast is off or not fetched yet). */
    public get forecast(): ForecastHour[] {
        return this.hours;
    }

    public async start(): Promise<void> {
        await this.tick();
    }

    public stop(): void {
        this.host.adapter.clearTimeout(this.timer);
        this.timer = undefined;
    }

    private async tick(): Promise<void> {
        try {
            const now = Date.now();
            const home = this.host.home;
            const meteors = meteorShowers(home, now);
            this.meteorText = meteors.text;
            await this.host.write('astronomy.meteors', JSON.stringify(meteors));
            await this.host.write('astronomy.meteorsText', meteors.text);
            await this.host.adapter.delay(0);
            const ecl = eclipses(home, now);
            await this.host.write('astronomy.eclipses', JSON.stringify(ecl));
            await this.host.write('astronomy.eclipsesText', ecl.text);
            await this.host.adapter.delay(0);
            const events = skyEvents(home, now);
            await this.host.write('astronomy.events', JSON.stringify(events));
            await this.host.write(
                'astronomy.eventsText',
                events
                    .slice(0, 3)
                    .map(e => `${day(e.at)}: ${e.text}`)
                    .join('; '),
            );
            this.latest = { meteors, eclipses: ecl, events };
            if (this.host.stopped()) {
                return;
            }
            if (this.health && now >= this.nextForecast) {
                await this.fetchForecast();
            }
            this.onChange();
        } finally {
            if (!this.host.stopped()) {
                // hourly, or sooner when the forecast is due
                const nextInMs = Math.max(
                    30_000,
                    Math.min(3600_000, this.health ? this.nextForecast - Date.now() : 3600_000),
                );
                this.timer = this.host.adapter.setTimeout(() => void this.tick(), nextInMs);
            }
        }
    }

    private async fetchForecast(): Promise<void> {
        const h = this.host.home;
        this.nextForecast = Date.now() + 2 * 3600_000 + Math.floor(Math.random() * 600_000);
        try {
            const data = await this.fetchJson(
                `https://api.open-meteo.com/v1/forecast?latitude=${h.lat.toFixed(3)}&longitude=${h.lon.toFixed(3)}` +
                    '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&forecast_days=2&timeformat=unixtime',
                15_000,
            );
            if (this.host.stopped()) {
                return;
            }
            const hours = forecastHours(data, h);
            if (!hours.length) {
                throw new Error('unexpected answer');
            }
            this.hours = hours;
            this.health!.ok();
            const best = bestHours(hours, h, Date.now());
            await this.host.write('astronomy.forecast', JSON.stringify({ at: Date.now(), hours }));
            await this.host.write('astronomy.forecastText', best);
        } catch (err) {
            if (!this.host.stopped()) {
                this.health!.fail(err);
            }
        }
        await this.host.updateConnection();
    }
}
