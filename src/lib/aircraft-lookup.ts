// Aircraft detail for `sendTo lookup`: route (VRS standing data), photo (planespotters.net), airline name (VRS
// airlines list). Loaded only when asked; answers (including "nothing known") are cached, errors are not.

import { SourceHealth, type HealthLog } from './health';
import type { JsonFetcher, TextFetcher } from './http';
import { NM, metres, num } from './util';

export interface Airport {
    lat: number;
    lon: number;
}

export interface Route {
    from: string;
    to: string;
    fromName: string;
    toName: string;
    /** the aircraft is roughly on the way from A to B (null position: true) */
    plausible: boolean;
    fromPos: Airport;
    toPos: Airport;
}

export interface Photo {
    src: string;
    link: string;
    by: string;
}

export interface LookupResult {
    airline: string | null;
    route: Route | null;
    photo: Photo | null;
}

const DAY = 24 * 3600_000;
const ROUTE_TTL = DAY;
const PHOTO_TTL = 7 * DAY;
const AIRLINES_TTL = DAY;
const CACHE_MAX = 1000;
const TIMEOUT_MS = 10_000;

const AIRLINES_URL =
    'https://raw.githubusercontent.com/vradarserver/standing-data/main/airlines/schema-01/airlines.csv';

/** On the way from A to B: |ac−A| + |ac−B| ≤ |A−B| × 1.3 + 80 nm (generous for diversions and holding). */
export function plausible(lat: number, lon: number, a: Airport, b: Airport): boolean {
    const nm = (x1: number, y1: number, x2: number, y2: number): number => metres(x1, y1, x2, y2) / NM;
    return nm(lat, lon, a.lat, a.lon) + nm(lat, lon, b.lat, b.lon) <= nm(a.lat, a.lon, b.lat, b.lon) * 1.3 + 80;
}

/** "Edinburgh International Airport" → "Edinburgh". */
export function shortName(s: unknown): string {
    return (typeof s === 'string' ? s : '')
        .replace(/\b(International|Intl\.?|Airport|Aeropuerto|Aeroport|Flughafen)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** One CSV line → fields (quoted fields may contain commas and doubled quotes). */
export function csvFields(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else if (c === '"') {
                quoted = false;
            } else {
                cur += c;
            }
        } else if (c === '"') {
            quoted = true;
        } else if (c === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
}

/** VRS airlines.csv → ICAO code → name. */
export function parseAirlines(csv: string): Map<string, string> {
    const lines = csv.split(/\r?\n/);
    const head = csvFields(lines.shift() ?? '');
    const iName = head.indexOf('Name');
    const iIcao = head.indexOf('ICAO');
    const map = new Map<string, string>();
    if (iName < 0 || iIcao < 0) {
        return map;
    }
    for (const line of lines) {
        const f = csvFields(line);
        const code = (f[iIcao] ?? '').trim();
        const name = (f[iName] ?? '').trim();
        if (/^[A-Z]{3}$/.test(code) && name && !map.has(code)) {
            map.set(code, name);
        }
    }
    return map;
}

/** Airline from an airline-style callsign (three letters, then a digit: "BAW123"). */
export function airlineOf(callsign: string, airlines: Map<string, string> | null): string | null {
    return airlines && /^[A-Z]{3}\d/.test(callsign) ? (airlines.get(callsign.slice(0, 3)) ?? null) : null;
}

function airport(v: unknown): (Airport & { code: string; name: string }) | null {
    if (!v || typeof v !== 'object') {
        return null;
    }
    const a = v as Record<string, unknown>;
    const lat = num(a.lat);
    const lon = num(a.lon);
    const code = typeof a.iata === 'string' && a.iata ? a.iata : typeof a.icao === 'string' ? a.icao : '';
    if (lat === null || lon === null || !code) {
        return null;
    }
    return { lat, lon, code, name: shortName(a.location || a.name) };
}

/** VRS route file → route (first and last airport), or null. */
export function routeFrom(data: unknown, lat: number | null, lon: number | null): Route | null {
    const list = (data as { _airports?: unknown } | null)?._airports;
    if (!Array.isArray(list) || list.length < 2) {
        return null;
    }
    const a = airport(list[0]);
    const b = airport(list[list.length - 1]);
    if (!a || !b) {
        return null;
    }
    return {
        from: a.code,
        to: b.code,
        fromName: a.name,
        toName: b.name,
        plausible: lat === null || lon === null || plausible(lat, lon, a, b),
        fromPos: { lat: a.lat, lon: a.lon },
        toPos: { lat: b.lat, lon: b.lon },
    };
}

/** planespotters.net answer → first photo, or null. */
export function photoFrom(data: unknown): Photo | null {
    const photos = (data as { photos?: unknown } | null)?.photos;
    const p = Array.isArray(photos) ? (photos[0] as Record<string, unknown> | undefined) : undefined;
    if (!p) {
        return null;
    }
    const thumb = (p.thumbnail_large ?? p.thumbnail) as { src?: unknown } | undefined;
    const src = typeof thumb?.src === 'string' ? thumb.src : null;
    const link = typeof p.link === 'string' ? p.link : null;
    if (!src || !link) {
        return null;
    }
    return { src, link, by: typeof p.photographer === 'string' ? p.photographer : '' };
}

/** A small time-limited cache that drops the oldest entries beyond CACHE_MAX. */
class TtlCache<T> {
    private readonly map = new Map<string, { at: number; val: T }>();

    public constructor(private readonly ttl: number) {}

    public get(key: string, now: number): { val: T } | undefined {
        const e = this.map.get(key);
        return e && now - e.at < this.ttl ? { val: e.val } : undefined;
    }

    public set(key: string, val: T, now: number): void {
        this.map.delete(key);
        this.map.set(key, { at: now, val });
        while (this.map.size > CACHE_MAX) {
            this.map.delete(this.map.keys().next().value!);
        }
    }
}

export class AircraftLookup {
    private readonly routes = new TtlCache<Route | null>(ROUTE_TTL);
    private readonly photos = new TtlCache<Photo | null>(PHOTO_TTL);
    private airlines: Map<string, string> | null = null;
    private airlinesAt = 0;
    private airlinesFailed = false;
    private airlinesLoading: Promise<void> | null = null;
    private readonly vrs: SourceHealth;
    private readonly planespotters: SourceHealth;

    public constructor(
        log: HealthLog,
        private readonly getJson: JsonFetcher,
        private readonly getText: TextFetcher,
    ) {
        this.vrs = new SourceHealth('VRS standing data', log);
        this.planespotters = new SourceHealth('planespotters.net', log);
    }

    public async lookup(q: {
        hex: string;
        flight: string;
        reg: string | null;
        lat: number | null;
        lon: number | null;
    }): Promise<LookupResult> {
        const [route, photo] = await Promise.all([
            this.route(q.flight, q.lat, q.lon),
            this.photo(q.hex, q.reg),
            this.loadAirlines(),
        ]);
        return { airline: airlineOf(q.flight, this.airlines), route, photo };
    }

    private async route(callsign: string, lat: number | null, lon: number | null): Promise<Route | null> {
        if (!/^[A-Z0-9]{3,8}$/.test(callsign)) {
            return null;
        }
        const now = Date.now();
        // The cache keeps the airports; plausibility depends on where the aircraft is now.
        const hit = this.routes.get(callsign, now);
        if (hit) {
            return (
                hit.val && {
                    ...hit.val,
                    plausible: lat === null || lon === null || plausible(lat, lon, hit.val.fromPos, hit.val.toPos),
                }
            );
        }
        try {
            const data = await this.getJson(
                `https://vrs-standing-data.adsb.lol/routes/${callsign.slice(0, 2)}/${callsign}.json`,
                TIMEOUT_MS,
            );
            this.vrs.ok();
            const route = routeFrom(data, lat, lon);
            this.routes.set(callsign, route, now);
            return route;
        } catch (err) {
            this.vrs.fail(err);
            return null;
        }
    }

    private async photo(hex: string, reg: string | null): Promise<Photo | null> {
        const now = Date.now();
        const hit = this.photos.get(hex, now);
        if (hit) {
            return hit.val;
        }
        try {
            // By ICAO address first, then by registration: the two indexes don't fully overlap.
            let photo = photoFrom(
                await this.getJson(`https://api.planespotters.net/pub/photos/hex/${hex}`, TIMEOUT_MS),
            );
            if (!photo && reg) {
                photo = photoFrom(
                    await this.getJson(
                        `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`,
                        TIMEOUT_MS,
                    ),
                );
            }
            this.planespotters.ok();
            this.photos.set(hex, photo, now);
            return photo;
        } catch (err) {
            this.planespotters.fail(err);
            return null;
        }
    }

    /** The airline list, loaded on the first lookup and refreshed when a day old. */
    private async loadAirlines(): Promise<void> {
        // a fresh list is kept a day; after a failed load, try again at most once an hour
        if (Date.now() - this.airlinesAt < (this.airlines && !this.airlinesFailed ? AIRLINES_TTL : 3600_000)) {
            return;
        }
        this.airlinesLoading ??= (async () => {
            try {
                this.airlines = parseAirlines(await this.getText(AIRLINES_URL, 20_000));
                this.airlinesFailed = false;
                this.vrs.ok();
            } catch (err) {
                this.airlinesFailed = true;
                this.vrs.fail(err);
            }
            this.airlinesAt = Date.now();
            this.airlinesLoading = null;
        })();
        await this.airlinesLoading;
    }
}
