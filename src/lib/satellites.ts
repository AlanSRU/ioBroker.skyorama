// Satellites: CelesTrak orbits (twice a day at most), visible passes of the chosen satellites over home, pass alerts.

import * as sat from 'satellite.js';
import { type Host } from './host';
import { SourceHealth } from './health';
import { getText } from './http';
import { sunAltitude } from './astronomy';
import { DEG, clock, compass, round, type Location } from './util';

/** [name, line1, line2] */
export type Tle = [string, string, string];

/** A visible pass. Times in ms; az/el in degrees, all over the part of the pass that can be seen. */
export interface Pass {
    sat: string;
    /** above the horizon / below it again */
    rise: number;
    set: number;
    /** visible from / to */
    start: number;
    end: number;
    maxEl: number;
    maxAt: number;
    maxAz: number;
    fromAz: number;
    toAz: number;
}

/** The space stations: short names and object ids of their own; tracked by default. */
export const STATIONS: Record<string, { id: string; name: string }> = {
    iss: { id: '25544', name: 'ISS' },
    tiangong: { id: '48274', name: 'Tiangong' },
};

/** At most this many satellites are tracked (72 h of passes each is real CPU work on a small host). */
export const MAX_TRACKED = 20;

/** A tracked satellite: catalogue number, object id under `satellites.`, display name. */
export interface Tracked {
    id: string;
    key: string;
    name: string;
}

/** The setting (catalogue numbers) → valid, unique ids, at most MAX_TRACKED; ISS and Tiangong if not set. */
export function trackedIds(setting: unknown): { ids: string[]; capped: boolean } {
    if (!Array.isArray(setting)) {
        return { ids: Object.values(STATIONS).map(s => s.id), capped: false };
    }
    const ids = [...new Set(setting.map(v => String(v).trim()).filter(v => /^\d{1,9}$/.test(v)))];
    return { ids: ids.slice(0, MAX_TRACKED), capped: ids.length > MAX_TRACKED };
}

/** Object id: the stations keep `iss` / `tiangong`, others `n<catalogue number>`. */
export function keyOf(id: string): string {
    return Object.entries(STATIONS).find(([, s]) => s.id === id)?.[0] ?? `n${id}`;
}

/** Display name: the stations' short names, otherwise the orbit set's name. */
export function nameOf(id: string, tle?: Tle): string {
    return Object.values(STATIONS).find(s => s.id === id)?.name ?? (tle ? tle[0].trim() : `Satellite ${id}`);
}

/** Options for the settings: stations first, then by name; selected satellites missing from the set stay listed. */
export function satelliteOptions(tle: Tle[], selected: string[]): { value: string; label: string }[] {
    const byId = new Map(tle.map(t => [catalogueNumber(t[1]), t]));
    const stationIds = Object.values(STATIONS).map(s => s.id);
    const others = [...byId.keys()].filter(id => !stationIds.includes(id));
    others.sort((a, b) => nameOf(a, byId.get(a)).localeCompare(nameOf(b, byId.get(b))));
    const ids = [...stationIds, ...others, ...selected.filter(id => !byId.has(id) && !stationIds.includes(id))];
    return ids.map(id => ({
        value: id,
        label: byId.has(id) ? `${nameOf(id, byId.get(id))} (${id})` : `${nameOf(id)} (${id}, not in the orbit set)`,
    }));
}

const PASS_HOURS = 72;
const STEP_MS = 20_000;
/** Visible: lit by the sun, at least this high, and the sky at the observer dark (sun below SUN_EL). */
const VIS_EL = 10;
const SUN_EL = -6;

export const ORBIT_REFRESH_MS = 12 * 3600_000;
/** CelesTrak blocks IPs that fetch the same data more often than every 2 h. */
const ORBIT_RETRY_MS = 2 * 3600_000;
const FETCH_TIMEOUT_MS = 20_000;

export function catalogueNumber(line1: string): string {
    return line1.slice(2, 7).trim();
}

/**
 * CelesTrak 3-line TLE text → [name, line1, line2][] (malformed entries skipped).
 */
export function parseTle(text: string): Tle[] {
    const lines = text
        .split(/\r?\n/)
        .map(l => l.trimEnd())
        .filter(Boolean);
    const out: Tle[] = [];
    for (let i = 0; i + 2 < lines.length;) {
        if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
            out.push([lines[i].trim(), lines[i + 1], lines[i + 2]]);
            i += 3;
        } else {
            i++;
        }
    }
    return out;
}

/**
 * Merge fetched groups into one set, deduplicated by catalogue number. From `stations` keep only the stations
 * themselves: their other modules and docked craft share their orbit.
 */
export function mergeGroups(groups: { group: string; sats: Tle[] }[]): Tle[] {
    const keep = new Set(Object.values(STATIONS).map(s => s.id));
    const byId = new Map<string, Tle>();
    for (const { group, sats } of groups) {
        for (const s of sats) {
            const id = catalogueNumber(s[1]);
            if ((group !== 'stations' || keep.has(id)) && !byId.has(id)) {
                byId.set(id, s);
            }
        }
    }
    return [...byId.values()];
}

/**
 * Configured group list → valid CelesTrak group names; `stations` always included (passes need it).
 */
export function groupList(setting: unknown): string[] {
    const names = (typeof setting === 'string' ? setting : '')
        .split(/[\s,;]+/)
        .map(g => g.trim().toLowerCase())
        .filter(g => /^[a-z0-9-]{1,40}$/.test(g));
    return [...new Set(['stations', ...names])];
}

/**
 * Lit by the sun: less than half the sun's disc hidden by the earth (the edge of the earth's shadow cylinder).
 * `sun` is the sun's position in AU (`sunPos().rsun`), `r` the satellite's in km, both ECI.
 */
export function sunlit(r: sat.EciVec3<number>, sun: sat.EciVec3<number>): boolean {
    return sat.shadowFraction(sun, r) < 0.5;
}

/**
 * Where the satellite is seen from home at `t`, or null if it can't be propagated (decayed, bad elements).
 */
export function lookAt(rec: sat.SatRec, home: Location, t: number): { az: number; el: number; lit: boolean } | null {
    const date = new Date(t);
    // null for bad elements; the decay check also catches long-decayed objects that SGP4 still "propagates"
    const pv = sat.propagate(rec, date, { communityDecayCheckEnabled: true });
    if (!pv) {
        return null;
    }
    const jd = sat.jday(date);
    const la = sat.ecfToLookAngles(
        { latitude: home.lat / DEG, longitude: home.lon / DEG, height: home.height / 1000 },
        sat.eciToEcf(pv.position, sat.gstime(jd)),
    );
    return {
        az: (la.azimuth * DEG + 360) % 360,
        el: la.elevation * DEG,
        lit: sunlit(pv.position, sat.sunPos(jd).rsun),
    };
}

/**
 * Visible passes of one satellite from `from` for `hours`. `sunAlt(t)` = sun altitude at home in degrees.
 */
export function predictPasses(
    name: string,
    rec: sat.SatRec,
    home: Location,
    from: number,
    hours: number,
    sunAlt: (t: number) => number,
): Pass[] {
    const out: Pass[] = [];
    let cur: Pass | null = null;
    let visible = false;
    const finish = (): void => {
        if (cur && visible) {
            out.push(cur);
        }
        cur = null;
        visible = false;
    };
    for (let t = from; t <= from + hours * 3600_000; t += STEP_MS) {
        const p = lookAt(rec, home, t);
        if (!p || p.el <= 0) {
            finish();
            continue;
        }
        cur ??= { sat: name, rise: t, set: t, start: 0, end: 0, maxEl: 0, maxAt: 0, maxAz: 0, fromAz: 0, toAz: 0 };
        cur.set = t;
        if (p.el >= VIS_EL && p.lit && sunAlt(t) < SUN_EL) {
            if (!visible) {
                Object.assign(cur, { start: t, fromAz: p.az });
                visible = true;
            }
            cur.end = t;
            cur.toAz = p.az;
            if (p.el > cur.maxEl) {
                Object.assign(cur, { maxEl: p.el, maxAt: t, maxAz: p.az });
            }
        }
    }
    finish();
    return out;
}

export function passText(p: Pass, now: number): string {
    const mins = Math.max(1, Math.round((p.end - p.start) / 60_000));
    return (
        `${p.sat} visible from ${clock(p.start, now)} for ${mins} min: from the ${compass(p.fromAz)}, ` +
        `highest ${Math.round(p.maxEl)}° in the ${compass(p.maxAz)} at ${clock(p.maxAt, now).slice(-5)}, ` +
        `towards the ${compass(p.toAz)}`
    );
}

/** An alert already sent: the same satellite coming into view at about the same time. */
export interface Alerted {
    sat: string;
    start: number;
}

/**
 * Passes whose alert is due now: coming into view within `leadMin`, high enough, not alerted before. Re-planning
 * moves a pass's times by up to one step, so "the same pass" is the same satellite within 5 minutes.
 */
export function dueAlerts(passes: Pass[], now: number, leadMin: number, minEl: number, alerted: Alerted[]): Pass[] {
    return passes.filter(
        p =>
            p.start > now &&
            p.start - now <= leadMin * 60_000 &&
            p.maxEl >= minEl &&
            !alerted.some(a => a.sat === p.sat && Math.abs(a.start - p.start) < 5 * 60_000),
    );
}

function roundPass(p: Pass): Pass {
    return { ...p, maxEl: round(p.maxEl), maxAz: round(p.maxAz), fromAz: round(p.fromAz), toAz: round(p.toAz) };
}

export interface SatellitesConfig {
    groups: string[];
    leadMin: number;
    minEl: number;
    /** catalogue numbers of the satellites to track */
    tracked: string[];
}

/** Runs the module: orbit refresh, pass planning (hourly), the per-minute visible/next/alert update. */
export class SatellitesModule {
    public readonly health: SourceHealth;
    private tle: Tle[] = [];
    private tleAt = 0;
    private tleGroups: string[] = [];
    private passes: Pass[] = [];
    /** passes alerted already; kept in each satellite's passes JSON so a restart doesn't alert them again */
    private alerted: Alerted[] = [];
    private readonly names = new Map<string, string>();
    private fetchTimer: ioBroker.Timeout | undefined;
    private planTimer: ioBroker.Interval | undefined;
    private tickTimer: ioBroker.Interval | undefined;

    public constructor(
        private readonly host: Host,
        private readonly cfg: SatellitesConfig,
        /** called after the passes were re-planned */
        private readonly onPasses: () => void,
    ) {
        this.health = new SourceHealth('CelesTrak', host.log, 'celestrak');
        this.health.unproven();
    }

    /** The orbit set, for `sendTo tle`. */
    public get orbits(): { at: number; groups: string[]; sats: Tle[] } {
        return { at: this.tleAt, groups: this.tleGroups, sats: this.tle };
    }

    /** Catalogue numbers of the satellites chosen in the settings. */
    public get trackedIds(): readonly string[] {
        return this.cfg.tracked;
    }

    public get visiblePasses(): readonly Pass[] {
        return this.passes;
    }

    public async start(): Promise<void> {
        // The last good set survives restarts, so a restart never costs CelesTrak a fetch.
        let savedGroups: string[] = [];
        for (const id of this.cfg.tracked) {
            const st = await this.host.adapter.getStateAsync(`satellites.${keyOf(id)}.passes`);
            try {
                const j = JSON.parse(String(st?.val || '{}')) as { passes?: (Pass & { alerted?: boolean })[] };
                for (const p of j.passes ?? []) {
                    if (p.alerted && typeof p.sat === 'string' && typeof p.start === 'number') {
                        this.alerted.push({ sat: p.sat, start: p.start });
                    }
                }
            } catch {
                // nothing to restore
            }
        }
        const saved = await this.host.adapter.getStateAsync('satellites.tle');
        try {
            const j = JSON.parse(String(saved?.val || '{}')) as { at?: number; sats?: Tle[]; groups?: string[] };
            if (Array.isArray(j.sats) && typeof j.at === 'number') {
                this.tle = j.sats;
                this.tleAt = j.at;
                savedGroups = Array.isArray(j.groups) ? j.groups : [];
                this.tleGroups = savedGroups;
            }
        } catch {
            // no usable saved set
        }
        if (this.host.stopped()) {
            return;
        }
        const age = Date.now() - this.tleAt;
        const fresh = this.tle.length > 0 && age < ORBIT_REFRESH_MS;
        const sameGroups = savedGroups.join() === this.cfg.groups.join();
        // Spread the load: never at a fixed time, and a jittered first fetch after startup.
        const soon = 5_000 + jitter(55_000);
        if (fresh) {
            // a successful fetch less than 12 h ago (whatever the groups) shows CelesTrak is reachable
            this.health.ok();
        }
        if (fresh && sameGroups) {
            this.scheduleFetch(ORBIT_REFRESH_MS - age + jitter(30 * 60_000));
        } else if (fresh) {
            // groups changed in the settings: fetch, but never sooner than 2 h after the last fetch
            this.scheduleFetch(Math.max(soon, ORBIT_RETRY_MS - age + jitter(10 * 60_000)));
        } else {
            this.scheduleFetch(soon);
        }
        await this.host.updateConnection();
        await this.plan();
        if (this.host.stopped()) {
            return;
        }
        this.planTimer = this.host.adapter.setInterval(() => void this.plan(), 3600_000);
        this.tickTimer = this.host.adapter.setInterval(() => void this.tick(), 60_000);
    }

    public stop(): void {
        this.host.adapter.clearTimeout(this.fetchTimer);
        this.host.adapter.clearInterval(this.planTimer);
        this.host.adapter.clearInterval(this.tickTimer);
    }

    private scheduleFetch(ms: number): void {
        this.host.adapter.clearTimeout(this.fetchTimer);
        this.fetchTimer = this.host.adapter.setTimeout(() => void this.fetch(), ms);
    }

    private async fetch(): Promise<void> {
        const results: { group: string; sats: Tle[] }[] = [];
        let failed = false;
        for (const group of this.cfg.groups) {
            try {
                const text = await getText(
                    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`,
                    FETCH_TIMEOUT_MS,
                );
                const sats = parseTle(text);
                if (!sats.length) {
                    // CelesTrak answers 200 with a plain-text message for unknown groups
                    this.host.log.warn(`CelesTrak: group "${group}" returned no orbits (${text.slice(0, 80).trim()})`);
                }
                results.push({ group, sats });
            } catch (err) {
                failed = true;
                if (!this.host.stopped()) {
                    this.health.fail(err);
                }
                break;
            }
            if (this.host.stopped()) {
                return;
            }
        }
        if (this.host.stopped()) {
            return;
        }
        if (!failed) {
            this.health.ok();
        }
        await this.host.updateConnection();
        // Keep the last good set unless every group arrived: orbits stay usable for days.
        if (failed) {
            this.scheduleFetch(ORBIT_RETRY_MS + jitter(10 * 60_000));
            return;
        }
        this.tle = mergeGroups(results);
        this.tleAt = Date.now();
        this.tleGroups = this.cfg.groups;
        this.host.log.debug(`CelesTrak: ${this.tle.length} orbits`);
        await this.host.write('satellites.tle', JSON.stringify(this.orbits));
        this.scheduleFetch(ORBIT_REFRESH_MS + jitter(30 * 60_000));
        await this.plan();
    }

    /** The tracked satellites, with names from the orbit set (made unique: passes are told apart by name). */
    private get tracked(): Tracked[] {
        const list = this.cfg.tracked.map(id => ({
            id,
            key: keyOf(id),
            name: nameOf(
                id,
                this.tle.find(t => catalogueNumber(t[1]) === id),
            ),
        }));
        return list.map(t =>
            list.filter(x => x.name === t.name).length > 1 ? { ...t, name: `${t.name} (${t.id})` } : t,
        );
    }

    private isAlerted(p: Pass): boolean {
        return this.alerted.some(a => a.sat === p.sat && Math.abs(a.start - p.start) < 5 * 60_000);
    }

    /** One satellite's passes as JSON, alerted ones marked (that is what survives a restart). */
    private async writePasses(t: Tracked, at: number): Promise<void> {
        const passes = this.passes
            .filter(p => p.sat === t.name)
            .map(p => (this.isAlerted(p) ? { ...p, alerted: true } : p));
        await this.host.write(`satellites.${t.key}.passes`, JSON.stringify({ at, passes }));
    }

    /** Work out the visible passes of the tracked satellites for the next 72 h. */
    private async plan(): Promise<void> {
        const home = this.host.home;
        const from = Date.now();
        const all: Pass[] = [];
        for (const t of this.tracked) {
            const tle = this.tle.find(x => catalogueNumber(x[1]) === t.id);
            if (!tle && this.tle.length) {
                this.host.log.debug(
                    `Satellite ${t.id} is not in the orbit set (CelesTrak groups ${this.tleGroups.join(', ')})`,
                );
            }
            if (tle) {
                try {
                    all.push(
                        ...predictPasses(t.name, sat.twoline2satrec(tle[1], tle[2]), home, from, PASS_HOURS, x =>
                            sunAltitude(home, x),
                        ).map(roundPass),
                    );
                } catch (err) {
                    this.host.log.warn(`${t.name}: pass prediction failed: ${String(err)}`);
                }
            }
            // the channel shows the satellite's name once the orbit set knows it
            if (this.names.get(t.key) !== t.name) {
                this.names.set(t.key, t.name);
                await this.host.adapter.extendObject(`satellites.${t.key}`, { common: { name: t.name } });
            }
            // CPU-bound work: let other adapters in the same (compact) process run between satellites.
            await this.host.adapter.delay(0);
            if (this.host.stopped()) {
                return;
            }
        }
        this.passes = all.sort((a, b) => a.start - b.start);
        for (const t of this.tracked) {
            await this.writePasses(t, from);
        }
        await this.tick();
        this.onPasses();
    }

    /** Once a minute: visible now, next pass, alerts. */
    private async tick(): Promise<void> {
        const now = Date.now();
        for (const { key, name } of this.tracked) {
            const mine = this.passes.filter(p => p.sat === name);
            const next = mine.find(p => p.end >= now);
            await this.host.write(
                `satellites.${key}.visibleNow`,
                mine.some(p => p.start <= now && now <= p.end),
            );
            await this.host.write(`satellites.${key}.next.start`, next ? next.start : null);
            await this.host.write(`satellites.${key}.next.end`, next ? next.end : null);
            await this.host.write(`satellites.${key}.next.maxEl`, next ? next.maxEl : null);
            await this.host.write(`satellites.${key}.next.maxAt`, next ? next.maxAt : null);
            await this.host.write(`satellites.${key}.next.fromAz`, next ? next.fromAz : null);
            await this.host.write(`satellites.${key}.next.toAz`, next ? next.toAz : null);
            await this.host.write(`satellites.${key}.next.text`, next ? passText(next, now) : '');
        }
        for (const p of dueAlerts(this.passes, now, this.cfg.leadMin, this.cfg.minEl, this.alerted)) {
            this.alerted.push({ sat: p.sat, start: p.start });
            const t = this.tracked.find(x => x.name === p.sat);
            if (t) {
                await this.writePasses(t, now);
            }
            const text = passText(p, now);
            await this.host.write('satellites.alert', text, true);
            await this.host.notify('satellitePass', text);
        }
        this.alerted = this.alerted.filter(a => a.start > now - 3600_000);
    }
}

function jitter(maxMs: number): number {
    return Math.floor(Math.random() * maxMs);
}
