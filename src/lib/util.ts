// Small helpers shared by the modules.

/** An observer on the ground (degrees, metres above sea level). */
export interface Location {
    lat: number;
    lon: number;
    height: number;
}

export const DEG = 180 / Math.PI;

/**
 * A number from the settings: falls back to `def` when missing or not a number, then clamped to [min, max].
 */
export function clamp(value: unknown, min: number, max: number, def: number): number {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(n)) {
        return def;
    }
    return Math.min(max, Math.max(min, n));
}

/**
 * A valid latitude/longitude pair, or null. 0/0 counts as "not set" (the ioBroker default).
 */
export function toLocation(lat: unknown, lon: unknown, height?: unknown): Location | null {
    const la = typeof lat === 'string' && lat.trim() === '' ? NaN : Number(lat);
    const lo = typeof lon === 'string' && lon.trim() === '' ? NaN : Number(lon);
    if (
        !Number.isFinite(la) ||
        !Number.isFinite(lo) ||
        Math.abs(la) > 90 ||
        Math.abs(lo) > 180 ||
        (la === 0 && lo === 0)
    ) {
        return null;
    }
    const h = Number(height);
    return { lat: la, lon: lo, height: Number.isFinite(h) ? h : 0 };
}

const EARTH_RADIUS_M = 6371e3;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const h =
        Math.sin(((bLat - aLat) * RAD) / 2) ** 2 +
        Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(((bLon - aLon) * RAD) / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees 0–360. */
export function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const y = Math.sin((bLon - aLon) * RAD) * Math.cos(bLat * RAD);
    const x =
        Math.cos(aLat * RAD) * Math.sin(bLat * RAD) -
        Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLon - aLon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
}

export const NM = 1852;
export const FT = 0.3048;

/** A finite number, or null. */
export function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Azimuth in degrees → compass point (8 points).
 */
export function compass(az: number): string {
    return POINTS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "19:45" for a time later today, "Sat 19:45" otherwise (host local time).
 */
export function clock(t: number, now: number): string {
    const d = new Date(t);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return d.toDateString() === new Date(now).toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

/**
 * Round to `digits` decimals.
 */
export function round(n: number, digits = 0): number {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

/**
 * The local receiver URL from the settings: an http(s) URL without a user name or password (fetch refuses those, and
 * its error message would put the password in the log). `problem` says why a non-empty setting is not used.
 */
export function receiverUrlOf(setting: unknown): { url: string; problem?: string } {
    const s = typeof setting === 'string' ? setting.trim() : '';
    if (!s) {
        return { url: '' };
    }
    let u: URL;
    try {
        u = new URL(s);
    } catch {
        return { url: '', problem: 'is not a valid URL' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { url: '', problem: 'is not an http(s) URL' };
    }
    if (u.username || u.password) {
        return { url: '', problem: 'must not contain a user name or password (not supported)' };
    }
    return { url: u.href };
}
