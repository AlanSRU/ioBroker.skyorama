// Lightning: strikes near home from an MQTT feed in the Blitzortung format that the user configures (broker URL and
// topic prefix). Strikes are published per geohash, one character per topic level, so the adapter subscribes to the
// geohash cells that cover the configured radius around home.

import type { IClientOptions, MqttClient } from 'mqtt';
import { SourceHealth } from './health';
import type { Host } from './host';
import { bearing, compass, metres, num, round, type Location } from './util';

const KEEP_MS = 3600_000;
/** strikes kept for the nearest/near checks (the oldest are dropped first); the hourly count is exact regardless */
const MAX_STRIKES = 20_000;
/** strikes written to lightning.strikes (the newest) */
const JSON_STRIKES = 1_000;
const PUBLISH_MS = 5_000;
/** lightning.strikes is large: written at most this often */
const JSON_MS = 60_000;
/** a near strike after this long without one is "the first strike of a storm" */
const QUIET_MS = 30 * 60_000;
const MAX_CELLS = 32;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** a connection that lasted this long resets the reconnect backoff */
const STABLE_MS = 2 * 60_000;

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Geohash of a point, `len` characters. */
export function geohash(lat: number, lon: number, len: number): string {
    let latLo = -90;
    let latHi = 90;
    let lonLo = -180;
    let lonHi = 180;
    let out = '';
    let bits = 0;
    let ch = 0;
    let even = true;
    while (out.length < len) {
        if (even) {
            const mid = (lonLo + lonHi) / 2;
            ch = (ch << 1) | (lon >= mid ? 1 : 0);
            if (lon >= mid) {
                lonLo = mid;
            } else {
                lonHi = mid;
            }
        } else {
            const mid = (latLo + latHi) / 2;
            ch = (ch << 1) | (lat >= mid ? 1 : 0);
            if (lat >= mid) {
                latLo = mid;
            } else {
                latHi = mid;
            }
        }
        even = !even;
        if (++bits === 5) {
            out += BASE32[ch];
            bits = 0;
            ch = 0;
        }
    }
    return out;
}

/** The cell a geohash stands for. */
export function geohashBox(hash: string): { latLo: number; latHi: number; lonLo: number; lonHi: number } {
    let latLo = -90;
    let latHi = 90;
    let lonLo = -180;
    let lonHi = 180;
    let even = true;
    for (const c of hash) {
        const v = BASE32.indexOf(c);
        for (let b = 4; b >= 0; b--) {
            const bit = (v >> b) & 1;
            if (even) {
                const mid = (lonLo + lonHi) / 2;
                if (bit) {
                    lonLo = mid;
                } else {
                    lonHi = mid;
                }
            } else {
                const mid = (latLo + latHi) / 2;
                if (bit) {
                    latLo = mid;
                } else {
                    latHi = mid;
                }
            }
            even = !even;
        }
    }
    return { latLo, latHi, lonLo, lonHi };
}

/** Size of a geohash cell of `len` characters, degrees. */
function cellSize(len: number): { dLat: number; dLon: number } {
    const lonBits = Math.ceil((len * 5) / 2);
    const latBits = Math.floor((len * 5) / 2);
    return { dLat: 180 / 2 ** latBits, dLon: 360 / 2 ** lonBits };
}

/**
 * Distance (m) from a point to a lat/lon box, from below: the nearest of a 9×9 sample of the box (and the pole, when
 * the box touches it), minus half a sample step. Errs towards including a cell, never towards missing strikes.
 */
function distanceToBox(lat: number, lon: number, b: ReturnType<typeof geohashBox>): number {
    if (lat >= b.latLo && lat <= b.latHi && lon >= b.lonLo && lon <= b.lonHi) {
        return 0;
    }
    const n = 8;
    let best = Infinity;
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
            const la = b.latLo + ((b.latHi - b.latLo) * i) / n;
            const lo = b.lonLo + ((b.lonHi - b.lonLo) * j) / n;
            best = Math.min(best, metres(lat, lon, la, lo));
        }
    }
    if (b.latHi >= 90) {
        best = Math.min(best, metres(lat, lon, 90, 0));
    }
    if (b.latLo <= -90) {
        best = Math.min(best, metres(lat, lon, -90, 0));
    }
    const step = metres(b.latLo, b.lonLo, b.latLo + (b.latHi - b.latLo) / n, b.lonLo + (b.lonHi - b.lonLo) / n);
    return Math.max(0, best - step / 2);
}

/** Geohash cells of one length that together cover the circle. */
export function coverCells(home: Location, radiusKm: number, len: number): string[] {
    const { dLat, dLon } = cellSize(len);
    const rDeg = radiusKm / 111.2;
    const latLo = Math.max(-90, home.lat - rDeg);
    const latHi = Math.min(90, home.lat + rDeg);
    const cosLat = Math.cos((Math.max(Math.abs(latLo), Math.abs(latHi)) * Math.PI) / 180);
    // near a pole the circle spans every longitude
    const lonSpan = cosLat < 0.01 || rDeg / cosLat >= 180 ? 180 : rDeg / cosLat;
    const cells = new Set<string>();
    for (let lat = latLo; lat <= latHi + dLat / 2; lat += dLat / 2) {
        for (let lon = home.lon - lonSpan; lon <= home.lon + lonSpan + dLon / 2; lon += dLon / 2) {
            const la = Math.min(89.999999, Math.max(-90, lat));
            const lo = ((((lon + 180) % 360) + 360) % 360) - 180;
            cells.add(geohash(la, lo, len));
        }
    }
    return [...cells].filter(c => distanceToBox(home.lat, home.lon, geohashBox(c)) <= radiusKm * 1000).sort();
}

/** Topic prefix from the settings: MQTT topic levels without wildcards, no leading/trailing slash. */
export function topicPrefixOf(setting: unknown): string {
    const s = typeof setting === 'string' ? setting.trim().replace(/^\/+|\/+$/g, '') : '';
    return /^[^#+\s]+$/.test(s) ? s : '';
}

/** The finest cover with at most 32 cells (fewer, larger cells for big radii), as topics under `prefix`. */
export function coverTopics(home: Location, radiusKm: number, prefix: string): string[] {
    for (let len = 4; len >= 1; len--) {
        const cells = coverCells(home, radiusKm, len);
        if (cells.length <= MAX_CELLS || len === 1) {
            return cells.map(c => `${prefix}/${c.split('').join('/')}/#`);
        }
    }
    return [`${prefix}/#`];
}

export interface Strike {
    lat: number;
    lon: number;
    /** ms */
    t: number;
    km: number;
}

/** One Blitzortung message → strike (time in ns since 1970 → ms), or null. */
export function parseStrike(payload: string, home: Location, now: number): Strike | null {
    let s: Record<string, unknown>;
    try {
        s = JSON.parse(payload) as Record<string, unknown>;
    } catch {
        return null;
    }
    const lat = num(s?.lat);
    const lon = num(s?.lon);
    if (lat === null || lon === null) {
        return null;
    }
    const ns = num(s.time);
    return {
        lat: round(lat, 4),
        lon: round(lon, 4),
        t: ns !== null ? Math.round(ns / 1e6) : now,
        km: round(metres(home.lat, home.lon, lat, lon) / 1000, 1),
    };
}

export interface LightningConfig {
    radiusKm: number;
    nearKm: number;
    /** mqtt(s):// or ws(s):// broker URL */
    brokerUrl: string;
    /** topic prefix, e.g. the feed's version path */
    topicPrefix: string;
    /** optional broker login */
    username: string;
    password: string;
}

export type MqttConnect = (url: string, opts: IClientOptions) => MqttClient;

/** Runs the module: one MQTT connection, strikes of the last hour, states every 5 s when something changed. */
export class LightningModule {
    public readonly health: SourceHealth;
    private client: MqttClient | undefined;
    private strikes: Strike[] = [];
    /** times of every strike within the radius in the last hour (the exact count) */
    private times: number[] = [];
    private jsonAt = 0;
    private dirty = true;
    private lastNearAt = 0;
    private publishTimer: ioBroker.Interval | undefined;
    private reconnectTimer: ioBroker.Timeout | undefined;
    private reconnectMs = RECONNECT_MIN_MS;
    private connectedAt = 0;
    private readonly topics: string[];
    private lastError = '';

    public constructor(
        private readonly host: Host,
        private readonly cfg: LightningConfig,
        private readonly connect: MqttConnect,
    ) {
        this.health = new SourceHealth('Lightning feed', host.log, 'lightning');
        // a persistent feed: not reachable until it has connected once
        this.health.unproven();
        this.topics = coverTopics(host.home, cfg.radiusKm, cfg.topicPrefix);
    }

    /** Strikes within the radius in the last hour (newest last), for the map page. */
    public recentStrikes(now = Date.now()): { radiusKm: number; total: number; strikes: Strike[] } {
        const recent = this.strikes.filter(s => now - s.t <= KEEP_MS);
        // a big storm is thousands of strikes: the newest are enough for a map
        return { radiusKm: this.cfg.radiusKm, total: recent.length, strikes: recent.slice(-JSON_STRIKES) };
    }

    public async start(): Promise<void> {
        // the quiet-spell rule survives restarts: a storm in progress is not "the first strike" again
        this.lastNearAt = num((await this.host.adapter.getStateAsync('lightning.lastNearAt'))?.val) ?? 0;
        if (this.host.stopped()) {
            return;
        }
        this.host.log.debug(`Lightning feed: ${this.topics.length} topics for ${this.cfg.radiusKm} km`);
        this.open();
        this.publishTimer = this.host.adapter.setInterval(() => void this.publish(), PUBLISH_MS);
    }

    public stop(): void {
        this.host.adapter.clearInterval(this.publishTimer);
        this.host.adapter.clearTimeout(this.reconnectTimer);
        // Listeners stay: mqtt.js clears its connack timer in its own 'close' listener, and a late 'error' must find
        // ours (unhandled it would throw and, in compact mode, take the other adapters down). Ours ignore an old client.
        const client = this.client;
        this.client = undefined;
        client?.end(true);
    }

    /** Connect; reconnecting is ours (mqtt.js auto-reconnect off) so the backoff really applies. */
    private open(): void {
        if (this.host.stopped()) {
            return;
        }
        const client = this.connect(this.cfg.brokerUrl, {
            reconnectPeriod: 0,
            connectTimeout: 15_000,
            ...(this.cfg.username ? { username: this.cfg.username, password: this.cfg.password } : {}),
            clientId: `skyorama_${Math.random().toString(16).slice(2, 10)}`,
        });
        this.client = client;
        client.on('connect', () => {
            if (this.host.stopped() || client !== this.client) {
                return;
            }
            this.connectedAt = Date.now();
            this.health.ok();
            void this.host.updateConnection();
            client.subscribe(this.topics, err => {
                if (err && !this.host.stopped()) {
                    this.host.log.warn(`Lightning feed: subscribe failed: ${err.message}`);
                }
            });
        });
        client.on('message', (_topic, payload) => {
            if (client === this.client) {
                this.onStrike(payload.toString());
            }
        });
        client.on('error', err => {
            // 'close' follows and schedules the reconnect; the error is logged once per outage there
            if (client === this.client) {
                this.lastError = err.message;
            }
        });
        client.on('close', () => this.onClose(client));
    }

    private onClose(client: MqttClient): void {
        if (this.host.stopped() || client !== this.client) {
            return;
        }
        this.client = undefined;
        client.end(true);
        const lasted = this.connectedAt ? Date.now() - this.connectedAt : 0;
        this.connectedAt = 0;
        if (lasted >= STABLE_MS) {
            this.reconnectMs = RECONNECT_MIN_MS;
        }
        this.health.fail(new Error(this.lastError || 'connection closed'));
        this.lastError = '';
        void this.host.updateConnection();
        this.reconnectTimer = this.host.adapter.setTimeout(() => this.open(), this.reconnectMs);
        this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    }

    private onStrike(payload: string): void {
        const now = Date.now();
        const s = parseStrike(payload, this.host.home, now);
        if (!s || s.km > this.cfg.radiusKm) {
            return;
        }
        this.strikes.push(s);
        this.times.push(s.t);
        this.dirty = true;
    }

    /** Batched: a storm can bring several strikes a second. */
    private async publish(): Promise<void> {
        const now = Date.now();
        const before = this.times.length;
        this.times = this.times.filter(t => now - t <= KEEP_MS);
        this.strikes = this.strikes.filter(s => now - s.t <= KEEP_MS);
        if (this.strikes.length > MAX_STRIKES) {
            this.strikes = this.strikes.slice(-MAX_STRIKES);
        }
        if (!this.dirty && this.times.length === before) {
            return;
        }
        this.dirty = false;
        const nearest = this.strikes.reduce<Strike | null>((m, s) => (!m || s.km < m.km ? s : m), null);
        const near = this.strikes.filter(s => s.km <= this.cfg.nearKm);
        const latestNear = near.reduce<Strike | null>((m, s) => (!m || s.t > m.t ? s : m), null);
        if (now - this.jsonAt >= JSON_MS || this.times.length === 0 || this.jsonAt === 0) {
            this.jsonAt = now;
            const newest = this.strikes.slice(-JSON_STRIKES);
            await this.host.write(
                'lightning.strikes',
                JSON.stringify({ at: now, radiusKm: this.cfg.radiusKm, total: this.times.length, strikes: newest }),
            );
        } else {
            this.dirty = true; // the JSON is still due
        }
        await this.host.write('lightning.nearestKm', nearest ? round(nearest.km) : null);
        await this.host.write('lightning.count1h', this.times.length);
        if (latestNear && latestNear.t > this.lastNearAt) {
            // the first near strike after a quiet spell is an alert
            if (latestNear.t - this.lastNearAt > QUIET_MS || !this.lastNearAt) {
                const dir = compass(bearing(this.host.home.lat, this.host.home.lon, latestNear.lat, latestNear.lon));
                const text = `Lightning ${Math.round(latestNear.km)} km ${dir}`;
                await this.host.write('lightning.alert', text, true);
                await this.host.notify('lightning', text);
            }
            this.lastNearAt = latestNear.t;
            await this.host.write('lightning.lastNearAt', latestNear.t);
        }
    }
}
