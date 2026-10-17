// Aurora: can it actually be seen from home now? Dark enough (sun below −12°), aurora near enough (NOAA OVATION
// ≥ 10 % within 3° of latitude, usually poleward where it shows low on the horizon; or AuroraWatch UK amber/red), and not
// overcast (Open-Meteo cloud cover). Kp comes from the aurora-nowcast adapter when installed.

import { sunAltitude } from './astronomy';
import { SourceHealth } from './health';
import type { Host } from './host';
import { getJson, getText, type JsonFetcher, type TextFetcher } from './http';
import { num, type Location } from './util';

const NEAR_DEG = 3;
const NEAR_PROB = 10;
const DARK_SUN = -12;
/** fetch only from shortly before civil dusk until dawn: nothing can be seen in daylight */
const FETCH_SUN = -4;
const ALERT_GAP_MS = 6 * 3600_000;
const TICK_MS = 60_000;

export const AURORAWATCH_LEVELS = ['green', 'yellow', 'amber', 'red'] as const;
export type AuroraWatchLevel = (typeof AURORAWATCH_LEVELS)[number];

const URLS = {
    ovation: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    auroraWatch: 'https://aurorawatch-api.lancs.ac.uk/0.2/status/current-status.xml',
    cloud: (h: Location): string =>
        `https://api.open-meteo.com/v1/forecast?latitude=${h.lat.toFixed(3)}&longitude=${h.lon.toFixed(3)}&current=cloud_cover`,
};

/** What OVATION says around home. Probabilities in %, latitudes in whole degrees. */
export interface Ovation {
    /** home latitude, rounded to the grid */
    lat: number;
    here: number;
    /** highest probability within NEAR_DEG degrees of home (either side: under the oval it can be south of you) */
    near: number;
    nearLat: number;
    /** where in home's hemisphere, along its longitude, the aurora is strongest */
    peak: number;
    peakLat: number;
    forecastAt: string | null;
}

/** OVATION grid (`coordinates: [lon 0–359, lat −90–90, %]`) → the values along home's longitude (±1°). */
export function ovationAround(data: unknown, home: Location): Ovation | null {
    const coords = (data as { coordinates?: unknown } | null)?.coordinates;
    if (!Array.isArray(coords)) {
        return null;
    }
    const lon0 = Math.round(((home.lon % 360) + 360) % 360) % 360;
    const lons = new Set([lon0 - 1, lon0, lon0 + 1].map(l => (l + 360) % 360));
    const lat0 = Math.round(home.lat);
    const north = home.lat >= 0;
    const prob = new Map<number, number>();
    for (const c of coords) {
        if (!Array.isArray(c)) {
            continue;
        }
        const [lon, lat, p] = c.map(num);
        if (lon === null || lat === null || p === null || !lons.has(lon)) {
            continue;
        }
        if (north ? lat >= 0 : lat <= 0) {
            prob.set(lat, Math.max(prob.get(lat) ?? 0, p));
        }
    }
    if (!prob.size) {
        return null;
    }
    let near = 0;
    let nearLat = lat0;
    let peak = -1;
    let peakLat = lat0;
    for (const [lat, p] of [...prob].sort((a, b) => Math.abs(a[0] - lat0) - Math.abs(b[0] - lat0))) {
        // nearest first, so ties go to the cell closest to home
        if (Math.abs(lat - lat0) <= NEAR_DEG && p > near) {
            near = p;
            nearLat = lat;
        }
        if (p > peak) {
            peak = p;
            peakLat = lat;
        }
    }
    const at = (data as Record<string, unknown>)['Forecast Time'];
    return {
        lat: lat0,
        here: prob.get(lat0) ?? 0,
        near,
        nearLat,
        peak,
        peakLat,
        forecastAt: typeof at === 'string' ? at : null,
    };
}

/** AuroraWatch UK status XML → level, or null. */
export function auroraWatchLevel(xml: string): AuroraWatchLevel | null {
    const m = /status_id="([a-z]+)"/.exec(xml);
    return m && (AURORAWATCH_LEVELS as readonly string[]).includes(m[1]) ? (m[1] as AuroraWatchLevel) : null;
}

/** Open-Meteo answer → cloud cover %, or null. */
export function cloudCover(data: unknown): number | null {
    return num((data as { current?: { cloud_cover?: unknown } } | null)?.current?.cloud_cover);
}

export interface AuroraInputs {
    sunAlt: number;
    ovation: Ovation | null;
    cloud: number | null;
    /** null: off or unknown */
    auroraWatch: AuroraWatchLevel | null;
    kp: number | null;
    cloudLimit: number;
    north: boolean;
}

export interface AuroraVerdict {
    possible: boolean;
    reason: string;
    summary: string;
}

const lat = (l: number): string => `${Math.abs(l)}°${l >= 0 ? 'N' : 'S'}`;

/** Where to look for the aurora OVATION found near home: north, south or straight up. */
function where(o: Ovation): 'north' | 'south' | 'up' {
    return o.nearLat > o.lat ? 'north' : o.nearLat < o.lat ? 'south' : 'up';
}

export function decide(i: AuroraInputs): AuroraVerdict {
    // AuroraWatch UK alone: the aurora is poleward of the UK
    const side = i.north ? 'north' : 'south';
    const dark = i.sunAlt < DARK_SUN;
    const near = !!i.ovation && i.ovation.near >= NEAR_PROB;
    const strong = i.auroraWatch === 'amber' || i.auroraWatch === 'red';
    const clear = i.cloud !== null && i.cloud < i.cloudLimit;
    const kp = i.kp !== null ? ` (Kp ${i.kp.toFixed(1)})` : '';
    if (dark && (near || strong) && clear) {
        const look = near ? where(i.ovation!) : side;
        const why = near
            ? look === 'up'
                ? `${i.ovation!.near} % overhead`
                : `${i.ovation!.near} % within ${NEAR_DEG}° ${look}`
            : `AuroraWatch UK ${i.auroraWatch}`;
        return {
            possible: true,
            reason: why,
            summary: `Possible from home: ${why}, ${i.cloud} % cloud${kp}. Look ${look}.`,
        };
    }
    const why: string[] = [];
    if (!dark) {
        why.push('not dark');
    }
    if (!(near || strong)) {
        why.push(
            i.ovation
                ? `aurora too far away (strongest near ${lat(i.ovation.peakLat)}, ${i.ovation.here} % here)`
                : 'no recent aurora data',
        );
    }
    if (!clear) {
        why.push(i.cloud === null ? 'cloud cover unknown' : `${i.cloud} % cloud`);
    }
    const reason = why.join(', ');
    return { possible: false, reason, summary: `Unlikely from home: ${reason}${kp}` };
}

export interface AuroraConfig {
    cloudLimit: number;
    auroraWatch: boolean;
    /** e.g. aurora-nowcast.0, or '' */
    nowcastInstance: string;
}

interface Source<T> {
    health: SourceHealth;
    intervalMs: number;
    /** data older than this counts as unknown */
    maxAgeMs: number;
    fetch: () => Promise<T>;
    value: T | null;
    at: number;
    nextAt: number;
    /** fetched (successfully or not) since the instance started */
    tried: boolean;
}

/** Runs the module: fetches while it is getting dark or dark, decides once a minute. */
export class AuroraModule {
    private readonly ovation: Source<Ovation | null>;
    private readonly cloud: Source<number | null>;
    private readonly watch: Source<AuroraWatchLevel | null> | null;
    private tickTimer: ioBroker.Timeout | undefined;
    private possible = false;
    private lastAlertAt = 0;

    public constructor(
        private readonly host: Host,
        private readonly cfg: AuroraConfig,
        deps: { getJson: JsonFetcher; getText: TextFetcher } = { getJson, getText },
    ) {
        const source = <T>(name: string, id: string, minutes: number, fetch: () => Promise<T>): Source<T> => ({
            health: new SourceHealth(name, host.log, id),
            intervalMs: minutes * 60_000,
            maxAgeMs: 3 * minutes * 60_000,
            fetch,
            value: null,
            at: 0,
            tried: false,
            // spread the load: a random first fetch within the first interval
            nextAt: Date.now() + 5_000 + Math.floor(Math.random() * minutes * 30_000),
        });
        this.ovation = source('NOAA SWPC', 'noaa', 10, async () =>
            ovationAround(await deps.getJson(URLS.ovation, 30_000), host.home),
        );
        this.cloud = source('Open-Meteo', 'openmeteo', 15, async () =>
            cloudCover(await deps.getJson(URLS.cloud(host.home), 15_000)),
        );
        this.watch = cfg.auroraWatch
            ? source('AuroraWatch UK', 'aurorawatch', 5, async () =>
                  auroraWatchLevel(await deps.getText(URLS.auroraWatch, 15_000)),
              )
            : null;
    }

    public get sources(): SourceHealth[] {
        return [this.ovation.health, this.cloud.health, ...(this.watch ? [this.watch.health] : [])];
    }

    public async start(): Promise<void> {
        // survive restarts: no second alert for the same aurora
        this.possible = (await this.host.adapter.getStateAsync('aurora.possible'))?.val === true;
        const alert = await this.host.adapter.getStateAsync('aurora.alert');
        this.lastAlertAt = alert?.val ? alert.ts : 0;
        if (this.host.stopped()) {
            return;
        }
        await this.tick();
    }

    public stop(): void {
        this.host.adapter.clearTimeout(this.tickTimer);
        this.tickTimer = undefined;
    }

    /** Once a minute, re-armed at the end: slow fetches never overlap or pile up. */
    private async tick(): Promise<void> {
        try {
            const now = Date.now();
            const sunAlt = sunAltitude(this.host.home, now);
            if (sunAlt < FETCH_SUN) {
                for (const s of [this.ovation, this.cloud, this.watch]) {
                    if (s && now >= s.nextAt) {
                        await this.fetch(s);
                        if (this.host.stopped()) {
                            return;
                        }
                    }
                }
            }
            // After a (re)start at night, keep the restored states until every source has answered once:
            // judging on no data would flip aurora.possible off and on again (and could alert twice).
            const ready = [this.ovation, this.cloud, this.watch].every(s => !s || s.tried);
            if (sunAlt >= DARK_SUN || ready) {
                await this.evaluate(sunAlt);
            }
        } finally {
            if (!this.host.stopped()) {
                this.tickTimer = this.host.adapter.setTimeout(() => void this.tick(), TICK_MS);
            }
        }
    }

    private async fetch(s: Source<unknown>): Promise<void> {
        s.nextAt = Date.now() + s.intervalMs;
        s.tried = true;
        try {
            const v = await s.fetch();
            if (this.host.stopped()) {
                return;
            }
            if (v === null) {
                throw new Error('unexpected answer');
            }
            s.value = v;
            s.at = Date.now();
            s.health.ok();
        } catch (err) {
            if (this.host.stopped()) {
                return;
            }
            s.health.fail(err);
        }
        await this.host.updateConnection();
    }

    private fresh<T>(s: Source<T> | null, now: number): T | null {
        return s && s.value !== null && now - s.at <= s.maxAgeMs ? s.value : null;
    }

    private async readKp(): Promise<number | null> {
        if (!this.cfg.nowcastInstance) {
            return null;
        }
        try {
            return num((await this.host.adapter.getForeignStateAsync(`${this.cfg.nowcastInstance}.kp.value`))?.val);
        } catch {
            return null;
        }
    }

    private async evaluate(sunAlt: number): Promise<void> {
        const now = Date.now();
        const inputs: AuroraInputs = {
            sunAlt: Math.round(sunAlt * 10) / 10,
            ovation: this.fresh(this.ovation, now),
            cloud: this.fresh(this.cloud, now),
            auroraWatch: this.fresh(this.watch, now),
            kp: await this.readKp(),
            cloudLimit: this.cfg.cloudLimit,
            north: this.host.home.lat >= 0,
        };
        const v = decide(inputs);
        await this.host.write('aurora.possible', v.possible);
        await this.host.write('aurora.reason', v.reason);
        await this.host.write('aurora.summary', v.summary);
        await this.host.write('aurora.inputs', JSON.stringify(inputs));
        if (v.possible && !this.possible && now - this.lastAlertAt > ALERT_GAP_MS) {
            this.lastAlertAt = now;
            await this.host.write('aurora.alert', v.summary, true);
            await this.host.notify('aurora', v.summary);
        }
        this.possible = v.possible;
    }
}
