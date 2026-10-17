// Aircraft: ADS-B from adsb.lol (area), adsb.fi (one aircraft), or a local readsb/dump1090/tar1090 receiver.
// Nothing polls unless something needs it: front-ends asking via sendTo, or the optional background polling for the
// summary states.

import { AircraftLookup, type LookupResult } from './aircraft-lookup';
import { SourceHealth } from './health';
import type { Host } from './host';
import { HttpError, getJson, getText, type JsonFetcher, type TextFetcher } from './http';
import { FT, NM, bearing, compass, metres, num, round, type Location } from './util';

/** One aircraft in an area answer. Units: ft, knots, nm, degrees, ft/min. */
export interface Aircraft {
    hex: string;
    flight: string | null;
    reg: string | null;
    type: string | null;
    lat: number;
    lon: number;
    /** barometric altitude, ft; 0 = on the ground; null = unknown */
    alt: number | null;
    gs: number | null;
    track: number | null;
    /** distance from home, nm */
    dst: number;
    /** bearing from home, degrees */
    dir: number;
    vr: number | null;
    selAlt: number | null;
    squawk: string | null;
    emergency: string | null;
    stale: boolean;
    trail: [number, number, number | null][];
}

/** A followed aircraft. altGeom is the GNSS height above the ellipsoid, ft. */
export interface Followed {
    lat: number;
    lon: number;
    altGeom: number | null;
    altBaro: number | null;
    gs: number | null;
    track: number | null;
    heading: number | null;
    roll: number | null;
    vr: number | null;
    seenPos: number;
    flight: string | null;
    reg: string | null;
    type: string | null;
    squawk: string | null;
    emergency: string | null;
}

export interface FollowResult {
    at: number;
    found: boolean;
    ac: Followed | null;
}

type Raw = Record<string, unknown>;

interface AreaResult {
    at: number;
    radiusNm: number;
    ac: Aircraft[];
    raw: Map<string, Raw>;
}

export const EMERGENCY_SQUAWK: Record<string, string> = {
    7500: 'hijack',
    7600: 'radio failure',
    7700: 'emergency',
};

const AREA_POLL_MS = 10_000;
const DEMAND_MS = 60_000;
/** an area answer this fresh is given to a new request without asking again */
const AREA_FRESH_MS = 15_000;
const AREA_TIMEOUT_MS = 15_000;
const FOLLOW_POLL_MS = 3_000;
const FOLLOW_KEEP_MS = 10_000;
/** adsb.fi open data: at most one request a second */
const ADSBFI_SPACING_MS = 1_100;
const STALE_S = 30;
const TRAIL_MS = 15 * 60_000;
const TRAIL_MIN_M = 400;
const TRAIL_MAX = 60;
const TRAIL_FORGET_MS = 5 * 60_000;
export const MAX_RADIUS_NM = 250;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A valid ICAO address ("~" = non-ICAO/TIS-B), lower case, or null. */
export function hexOf(v: unknown): string | null {
    return typeof v === 'string' && /^~?[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
}

function emergencyOf(a: Raw): string | null {
    const e = str(a.emergency);
    if (e && e !== 'none') {
        return e;
    }
    const sq = str(a.squawk);
    return (sq && EMERGENCY_SQUAWK[sq]) || null;
}

/** readsb JSON (adsb.lol / adsb.fi `ac`, local receiver `aircraft`) → the list. */
export function rawList(data: unknown): Raw[] {
    const d = data as { ac?: unknown; aircraft?: unknown } | null;
    const list = d?.ac ?? d?.aircraft;
    return Array.isArray(list) ? list.filter((a): a is Raw => !!a && typeof a === 'object') : [];
}

/** The answer carries an aircraft list (possibly empty). */
export function hasList(data: unknown): boolean {
    const d = data as { ac?: unknown; aircraft?: unknown } | null;
    return Array.isArray(d?.ac ?? d?.aircraft);
}

/** One readsb entry → Aircraft (without trail), or null without a position. Distance/bearing worked out here. */
export function toAircraft(a: Raw, home: Location): Omit<Aircraft, 'trail'> | null {
    const hex = hexOf(a.hex);
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (!hex || lat === null || lon === null) {
        return null;
    }
    return {
        hex,
        flight: str(a.flight),
        reg: str(a.r),
        type: str(a.t),
        lat,
        lon,
        alt: a.alt_baro === 'ground' ? 0 : num(a.alt_baro),
        gs: num(a.gs),
        track: num(a.track),
        dst: round(metres(home.lat, home.lon, lat, lon) / NM, 2),
        dir: round(bearing(home.lat, home.lon, lat, lon), 1),
        vr: num(a.baro_rate) ?? num(a.geom_rate),
        selAlt: num(a.nav_altitude_mcp),
        squawk: str(a.squawk),
        emergency: emergencyOf(a),
        stale: (num(a.seen_pos) ?? 0) > STALE_S,
    };
}

export function toFollowed(a: Raw): Followed | null {
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (lat === null || lon === null) {
        return null;
    }
    return {
        lat,
        lon,
        altGeom: num(a.alt_geom),
        altBaro: a.alt_baro === 'ground' ? 0 : num(a.alt_baro),
        gs: num(a.gs),
        track: num(a.track),
        heading: num(a.true_heading) ?? num(a.track),
        roll: num(a.roll),
        vr: num(a.geom_rate) ?? num(a.baro_rate),
        seenPos: num(a.seen_pos) ?? 0,
        flight: str(a.flight),
        reg: str(a.r),
        type: str(a.t),
        squawk: str(a.squawk),
        emergency: emergencyOf(a),
    };
}

/** Recent positions per aircraft: the last 15 min, a point every ≥ 400 m, at most 60, with altitude. */
export class Trails {
    private readonly map = new Map<string, { pts: [number, number, number, number | null][]; seen: number }>();

    /** Add the current positions; returns each aircraft's trail (without the current position). */
    public update(list: Omit<Aircraft, 'trail'>[], now: number): Aircraft[] {
        const out = list.map(a => {
            let t = this.map.get(a.hex);
            if (!t) {
                t = { pts: [], seen: now };
                this.map.set(a.hex, t);
            }
            t.seen = now;
            const last = t.pts[t.pts.length - 1];
            if (!last || metres(last[0], last[1], a.lat, a.lon) >= TRAIL_MIN_M) {
                t.pts.push([round(a.lat, 4), round(a.lon, 4), now, a.alt]);
            }
            while (t.pts.length && (t.pts.length > TRAIL_MAX || now - t.pts[0][2] > TRAIL_MS)) {
                t.pts.shift();
            }
            const trail = t.pts.slice(0, -1).map(p => [p[0], p[1], p[3]] as [number, number, number | null]);
            return { ...a, trail };
        });
        for (const [hex, t] of this.map) {
            if (now - t.seen > TRAIL_FORGET_MS) {
                this.map.delete(hex);
            }
        }
        return out;
    }
}

/** Angle above the horizon at home (flat-earth approximation, fine within a few hundred km), or null. */
export function elevationOf(a: Pick<Aircraft, 'alt' | 'dst'>, home: Location): number | null {
    if (a.alt === null || a.alt <= 0) {
        return null;
    }
    return (Math.atan2(a.alt * FT - home.height, Math.max(1, a.dst * NM)) * 180) / Math.PI;
}

export interface Summary {
    count: number;
    overhead: boolean;
    nearest: {
        callsign: string;
        type: string;
        registration: string;
        altitude: number | null;
        distance: number | null;
        bearing: number | null;
        elevation: number | null;
    };
    emergency: boolean;
    emergencyText: string;
}

/** The background states from one area answer (already trimmed to the background radius). */
export function summarise(list: Aircraft[], home: Location, overheadEl: number): Summary {
    const airborne = list.filter(a => a.alt !== null && a.alt > 0 && !a.stale);
    const nearest = airborne.reduce<Aircraft | null>((n, a) => (!n || a.dst < n.dst ? a : n), null);
    const em = list.filter(a => a.emergency);
    return {
        count: list.length,
        overhead: airborne.some(a => (elevationOf(a, home) ?? 0) >= overheadEl),
        nearest: {
            callsign: nearest?.flight ?? '',
            type: nearest?.type ?? '',
            registration: nearest?.reg ?? '',
            altitude: nearest?.alt ?? null,
            distance: nearest ? round((nearest.dst * NM) / 1000, 1) : null,
            bearing: nearest ? round(nearest.dir) : null,
            elevation: nearest ? round(elevationOf(nearest, home) ?? 0, 1) : null,
        },
        emergency: em.length > 0,
        emergencyText: em
            .map(
                a =>
                    `${a.flight ?? a.reg ?? a.hex}: ${a.emergency}${a.squawk ? ` (squawk ${a.squawk})` : ''}, ` +
                    `${round((a.dst * NM) / 1000)} km ${compass(a.dir)}`,
            )
            .join('; '),
    };
}

export interface AircraftConfig {
    /** local receiver aircraft.json URL, or '' */
    receiverUrl: string;
    background: { enabled: boolean; radiusNm: number; intervalMs: number };
    overheadEl: number;
}

export interface AircraftDeps {
    getJson: JsonFetcher;
    getText: TextFetcher;
}

/** Runs the module: area polling (on demand and background), followed aircraft, lookups. */
export class AircraftModule {
    public readonly area: SourceHealth;
    public readonly adsbfi: SourceHealth;
    public readonly adsblol: SourceHealth;
    private readonly lookups: AircraftLookup;
    private readonly trails = new Trails();
    private cache: AreaResult | null = null;
    private inflight: Promise<void> | null = null;
    private readonly demand = new Map<number, number>(); // radiusNm -> last asked
    private areaTimer: ioBroker.Timeout | undefined;
    private areaFailures = 0;
    /** after a failed area request, nothing (loop or sendTo) asks the source again before this time */
    private retryAt = 0;
    private readonly follows = new Map<string, number>(); // hex -> last asked
    private readonly followed = new Map<string, FollowResult>();
    private followTimer: ioBroker.Timeout | undefined;
    private followRunning = false;
    private fiQueue: Promise<void> = Promise.resolve();
    private lastFiAt = 0;

    public constructor(
        private readonly host: Host,
        private readonly cfg: AircraftConfig,
        private readonly deps: AircraftDeps = { getJson, getText },
    ) {
        this.adsblol = new SourceHealth('adsb.lol', host.log, 'adsblol');
        this.adsbfi = new SourceHealth('adsb.fi', host.log, 'adsbfi');
        this.area = cfg.receiverUrl ? new SourceHealth('Local receiver', host.log, 'receiver') : this.adsblol;
        this.lookups = new AircraftLookup(host.log, deps.getJson, deps.getText);
    }

    /** Sources that can affect info.connection. */
    public get sources(): SourceHealth[] {
        return this.cfg.receiverUrl ? [this.area, this.adsbfi, this.adsblol] : [this.adsblol, this.adsbfi];
    }

    public start(): void {
        if (this.cfg.background.enabled) {
            // spread the load: a jittered first poll after startup
            this.scheduleArea(5_000 + Math.floor(Math.random() * 25_000));
        }
    }

    public stop(): void {
        this.host.adapter.clearTimeout(this.areaTimer);
        this.host.adapter.clearTimeout(this.followTimer);
        this.areaTimer = undefined;
        this.followTimer = undefined;
    }

    // --- area -----------------------------------------------------------------------------------------------------

    /** `sendTo aircraft { radiusNm }`: aircraft within the radius, nearest first. */
    public async aircraft(
        radiusNm: number,
    ): Promise<{ at: number; radiusNm: number; ac: Aircraft[] } | { error: string }> {
        const now = Date.now();
        this.demand.set(radiusNm, now);
        if (!this.covers(radiusNm, now)) {
            if (this.inflight) {
                await this.inflight;
            }
            // while the source is failing or rate-limiting, answer from what we have instead of asking again
            if (!this.covers(radiusNm, Date.now()) && Date.now() >= this.retryAt) {
                await this.refresh();
            }
        }
        this.keepPolling();
        const c = this.cache;
        if (!c) {
            return { error: 'No aircraft data yet' };
        }
        const r = Math.min(radiusNm, c.radiusNm);
        return { at: c.at, radiusNm: r, ac: c.ac.filter(a => a.dst <= r) };
    }

    private covers(radiusNm: number, now: number): boolean {
        return !!this.cache && this.cache.radiusNm >= radiusNm && now - this.cache.at < AREA_FRESH_MS;
    }

    /** The radius to poll: the widest asked for in the last minute, and the background radius. 0 = nothing to do. */
    private wantedRadius(now: number): number {
        let r = this.cfg.background.enabled ? this.cfg.background.radiusNm : 0;
        for (const [radius, at] of this.demand) {
            if (now - at > DEMAND_MS) {
                this.demand.delete(radius);
            } else {
                r = Math.max(r, radius);
            }
        }
        return r;
    }

    private scheduleArea(ms: number): void {
        this.host.adapter.clearTimeout(this.areaTimer);
        this.areaTimer = this.host.stopped() ? undefined : this.host.adapter.setTimeout(() => void this.areaTick(), ms);
    }

    /** Make sure the loop runs while someone is asking. */
    private keepPolling(): void {
        if (!this.areaTimer && !this.inflight) {
            this.scheduleArea(AREA_POLL_MS);
        }
    }

    private async areaTick(): Promise<void> {
        this.areaTimer = undefined;
        if (this.inflight) {
            await this.inflight;
        } else if (this.wantedRadius(Date.now()) > 0 && Date.now() >= this.retryAt) {
            await this.refresh();
        }
        if (this.host.stopped()) {
            return;
        }
        const now = Date.now();
        const demand = [...this.demand.values()].some(at => now - at <= DEMAND_MS);
        if (!demand && !this.cfg.background.enabled) {
            return; // idle until the next request
        }
        const next = this.areaFailures
            ? Math.max(500, this.retryAt - now)
            : demand
              ? AREA_POLL_MS
              : this.cfg.background.intervalMs;
        this.scheduleArea(next);
    }

    /** One area request at a time, for the radius wanted now. */
    private refresh(): Promise<void> {
        this.inflight ??= this.fetchArea(this.wantedRadius(Date.now())).finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    private async fetchArea(radiusNm: number): Promise<void> {
        if (radiusNm <= 0) {
            return;
        }
        const home = this.host.home;
        const url =
            this.cfg.receiverUrl ||
            `https://api.adsb.lol/v2/lat/${home.lat.toFixed(4)}/lon/${home.lon.toFixed(4)}/dist/${Math.ceil(radiusNm)}`;
        let data: unknown;
        try {
            data = await this.deps.getJson(url, AREA_TIMEOUT_MS);
            // a wrong receiver path (404) or any answer without an aircraft list is a failure, not "no aircraft"
            if (!hasList(data)) {
                throw new Error(
                    data === null ? 'HTTP 404 (check the URL)' : 'the answer has no aircraft list (check the URL)',
                );
            }
        } catch (err) {
            if (this.host.stopped()) {
                return;
            }
            this.areaFailures++;
            // retry after 2 s, doubling up to a minute; rate limiting (429) waits at least 30 s
            const backoff = Math.min(60_000, 2_000 * 2 ** (this.areaFailures - 1));
            const rateLimited = err instanceof HttpError && err.status === 429;
            this.retryAt = Date.now() + (rateLimited ? Math.max(30_000, backoff) : backoff);
            this.area.fail(err);
            await this.host.updateConnection();
            return;
        }
        if (this.host.stopped()) {
            return;
        }
        this.areaFailures = 0;
        this.retryAt = 0;
        this.area.ok();
        const now = Date.now();
        const raw = new Map<string, Raw>();
        const list: Omit<Aircraft, 'trail'>[] = [];
        for (const a of rawList(data)) {
            const ac = toAircraft(a, home);
            if (ac && ac.dst <= radiusNm) {
                raw.set(ac.hex, a);
                list.push(ac);
            }
        }
        const ac = this.trails.update(list, now).sort((x, y) => x.dst - y.dst);
        this.cache = { at: now, radiusNm, ac, raw };
        await this.host.updateConnection();
        if (this.cfg.background.enabled) {
            await this.writeStates(ac.filter(a => a.dst <= this.cfg.background.radiusNm));
        }
    }

    private async writeStates(list: Aircraft[]): Promise<void> {
        const s = summarise(list, this.host.home, this.cfg.overheadEl);
        const w = this.host.write;
        await w('aircraft.count', s.count);
        await w('aircraft.overhead', s.overhead);
        await w('aircraft.emergency', s.emergency);
        await w('aircraft.emergencyText', s.emergencyText);
        await w('aircraft.list', JSON.stringify(list.map(({ trail: _trail, ...a }) => a)));
        await w('aircraft.nearest.callsign', s.nearest.callsign);
        await w('aircraft.nearest.type', s.nearest.type);
        await w('aircraft.nearest.registration', s.nearest.registration);
        await w('aircraft.nearest.altitude', s.nearest.altitude);
        await w('aircraft.nearest.distance', s.nearest.distance);
        await w('aircraft.nearest.bearing', s.nearest.bearing);
        await w('aircraft.nearest.elevation', s.nearest.elevation);
    }

    // --- follow ---------------------------------------------------------------------------------------------------

    /** `sendTo follow { hex }`: where the aircraft is now, wherever it is. Polled every 3 s while asked for. */
    public async follow(hex: string): Promise<FollowResult> {
        const now = Date.now();
        this.follows.set(hex, now);
        let c = this.followed.get(hex);
        if (!c) {
            // start at once from the last area search if the aircraft was in it; polling refines it
            const seen = this.cache && now - this.cache.at < DEMAND_MS ? this.cache.raw.get(hex) : undefined;
            const ac = seen ? toFollowed(seen) : null;
            if (ac && this.cache) {
                c = { at: this.cache.at, found: true, ac };
                this.followed.set(hex, c);
            } else {
                c = await this.followOnce(hex);
            }
        }
        if (!this.followTimer && !this.followRunning && !this.host.stopped()) {
            this.followTimer = this.host.adapter.setTimeout(() => void this.followTick(), FOLLOW_POLL_MS);
        }
        return c ?? { at: now, found: false, ac: null };
    }

    private async followTick(): Promise<void> {
        this.followTimer = undefined;
        this.followRunning = true;
        try {
            const now = Date.now();
            for (const [hex, at] of this.follows) {
                if (now - at > FOLLOW_KEEP_MS) {
                    this.follows.delete(hex);
                    this.followed.delete(hex);
                }
            }
            for (const hex of [...this.follows.keys()]) {
                await this.followOnce(hex);
                if (this.host.stopped()) {
                    return;
                }
            }
        } finally {
            this.followRunning = false;
        }
        // re-armed at the end, so slow answers never pile up
        if (this.follows.size && !this.host.stopped()) {
            this.followTimer = this.host.adapter.setTimeout(() => void this.followTick(), FOLLOW_POLL_MS);
        }
    }

    /** Ask for one aircraft and merge the answer: a miss keeps the last good position (found: false). */
    private async followOnce(hex: string): Promise<FollowResult | undefined> {
        const r = await this.fetchFollowed(hex);
        const prev = this.followed.get(hex);
        if (r && (r.found || !prev)) {
            this.followed.set(hex, r);
        } else if (r && prev) {
            prev.found = false;
        }
        return this.followed.get(hex);
    }

    /** adsb.fi first (fast, ≤ 1 request/s), adsb.lol as the fallback. null when both fail. */
    private async fetchFollowed(hex: string): Promise<FollowResult | null> {
        const sources: [SourceHealth, string, number][] = [
            [this.adsbfi, `https://opendata.adsb.fi/api/v2/hex/${hex}`, 4_000],
            [this.adsblol, `https://api.adsb.lol/v2/hex/${hex}`, 8_000],
        ];
        for (const [health, url, timeout] of sources) {
            try {
                if (health === this.adsbfi) {
                    await this.adsbfiSlot();
                }
                const data = await this.deps.getJson(url, timeout);
                if (this.host.stopped()) {
                    return null;
                }
                health.ok();
                await this.host.updateConnection();
                const a = rawList(data)
                    .map(toFollowed)
                    .find(x => x !== null);
                return { at: Date.now(), found: !!a, ac: a ?? null };
            } catch (err) {
                if (this.host.stopped()) {
                    return null;
                }
                health.fail(err);
                await this.host.updateConnection();
            }
        }
        return null;
    }

    /** Wait for a free adsb.fi slot: requests at least 1.1 s apart, across everything that asks. */
    private adsbfiSlot(): Promise<void> {
        const run = this.fiQueue.then(async () => {
            const gapMs = this.lastFiAt + ADSBFI_SPACING_MS - Date.now();
            if (gapMs > 0) {
                await this.host.adapter.delay(gapMs);
            }
            this.lastFiAt = Date.now();
        });
        this.fiQueue = run.catch(() => undefined);
        return run;
    }

    // --- lookup ---------------------------------------------------------------------------------------------------

    /** `sendTo lookup { hex, flight, reg, lat, lon }`: airline, route and photo. */
    public lookup(q: {
        hex: string;
        flight: string;
        reg: string | null;
        lat: number | null;
        lon: number | null;
    }): Promise<LookupResult> {
        return this.lookups.lookup(q);
    }
}
