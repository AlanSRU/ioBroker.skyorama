import { expect } from 'chai';
import {
    AircraftModule,
    Trails,
    elevationOf,
    hexOf,
    rawList,
    summarise,
    toAircraft,
    type Aircraft,
    type AircraftConfig,
} from './aircraft';
import type { Host } from './host';
import { HttpError, backoffMs, retryAfterOf } from './http';
import { NM, urlSettingOf, type Location } from './util';

const HOME: Location = { lat: 55.95, lon: -3.19, height: 0 };
/** a point `nm` nautical miles due north of home */
const north = (nm: number): number => HOME.lat + nm / 60;

function raw(hex: string, nm: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { hex, lat: north(nm), lon: HOME.lon, alt_baro: 30000, flight: `TST${hex.slice(-3)} `, ...extra };
}

describe('aircraft: feed data', () => {
    it('accepts ICAO addresses only', () => {
        expect(hexOf('ABC123')).to.equal('abc123');
        expect(hexOf('~1a2b3c')).to.equal('~1a2b3c');
        expect(hexOf('abc12')).to.equal(null);
        expect(hexOf('abc123/../x')).to.equal(null);
        expect(hexOf(123456)).to.equal(null);
    });

    it('reads both the API (ac) and the receiver (aircraft) format', () => {
        expect(rawList({ ac: [{ hex: 'a' }] })).to.have.length(1);
        expect(rawList({ aircraft: [{ hex: 'a' }, null] })).to.have.length(1);
        expect(rawList(null)).to.deep.equal([]);
    });

    it('works out distance and bearing from home, and maps the fields', () => {
        const a = toAircraft(raw('abc123', 10, { squawk: '7700', r: 'G-ABCD', t: 'A320' }), HOME)!;
        expect(a.dst).to.be.closeTo(10, 0.05);
        expect(a.dir).to.be.closeTo(0, 0.5);
        expect(a.flight).to.equal('TST123');
        expect(a.reg).to.equal('G-ABCD');
        expect(a.emergency).to.equal('emergency');
    });

    it('gives "ground" as 0 ft and keeps unknown values null', () => {
        const a = toAircraft({ hex: 'abc123', lat: HOME.lat, lon: HOME.lon, alt_baro: 'ground' }, HOME)!;
        expect(a.alt).to.equal(0);
        expect(a.gs).to.equal(null);
        expect(a.emergency).to.equal(null);
        expect(toAircraft({ hex: 'abc123', alt_baro: 1000 }, HOME)).to.equal(null);
    });
});

describe('aircraft: trails', () => {
    const at = (nm: number, alt = 30000): Omit<Aircraft, 'trail'> =>
        toAircraft(raw('abc123', nm, { alt_baro: alt }), HOME)!;

    it('adds a point every 400 m or more, with altitude, without the current position', () => {
        const t = new Trails();
        const t0 = Date.UTC(2026, 0, 1);
        t.update([at(10)], t0);
        expect(t.update([at(10.1)], t0 + 10_000)[0].trail).to.deep.equal([]); // 185 m: not added
        const out = t.update([at(10.3, 29000)], t0 + 20_000)[0];
        expect(out.trail).to.have.length(1);
        expect(out.trail[0][2]).to.equal(30000);
    });

    it('keeps at most 60 points and 15 minutes', () => {
        const t = new Trails();
        const t0 = Date.UTC(2026, 0, 1);
        let last: Aircraft[] = [];
        for (let i = 0; i < 80; i++) {
            last = t.update([at(i)], t0 + i * 1000);
        }
        expect(last[0].trail.length).to.equal(59);
        last = t.update([at(100)], t0 + 17 * 60_000);
        expect(last[0].trail.length).to.equal(0);
    });
});

describe('aircraft: summary', () => {
    const list = (rs: Record<string, unknown>[]): Aircraft[] =>
        rs.map(r => ({ ...toAircraft(r, HOME)!, trail: [] })).sort((a, b) => a.dst - b.dst);

    it('works out the elevation angle', () => {
        // 30 000 ft at 5 nm: atan(9144 / 9260) ≈ 44.6°
        expect(elevationOf({ alt: 30000, dst: 5 }, HOME)).to.be.closeTo(44.6, 0.1);
        expect(elevationOf({ alt: 0, dst: 5 }, HOME)).to.equal(null);
    });

    it('picks the nearest airborne aircraft and flags overhead and emergencies', () => {
        const s = summarise(
            list([
                raw('aaaaa1', 0.2, { alt_baro: 'ground' }),
                raw('aaaaa2', 3, { alt_baro: 20000 }),
                raw('aaaaa3', 20, { squawk: '7600' }),
            ]),
            HOME,
            45,
        );
        expect(s.count).to.equal(3);
        expect(s.nearest.callsign).to.equal('TSTaa2');
        expect(s.nearest.distance).to.be.closeTo((3 * NM) / 1000, 0.1);
        expect(s.overhead).to.equal(true); // 20 000 ft at 3 nm ≈ 47°
        expect(s.emergency).to.equal(true);
        expect(s.emergencyText).to.match(/^TSTaa3: radio failure \(squawk 7600\), 37 km N$/);
    });

    it('reports nothing (null, not 0) when no aircraft is airborne', () => {
        const s = summarise([], HOME, 45);
        expect(s.nearest.distance).to.equal(null);
        expect(s.nearest.altitude).to.equal(null);
        expect(s.overhead).to.equal(false);
    });
});

/** A fake adapter: real timers (cleared by stop()), delay recorded and skipped. */
function harness(
    cfg: Partial<AircraftConfig> = {},
    savedList?: string,
): {
    mod: AircraftModule;
    urls: string[];
    delays: number[];
    writes: Map<string, unknown>;
    respond: (fn: (url: string) => unknown) => void;
    notes: string[];
} {
    const urls: string[] = [];
    const delays: number[] = [];
    const writes = new Map<string, unknown>();
    const notes: string[] = [];
    const saved: { list?: string } = { list: savedList };
    let handler: (url: string) => unknown = () => ({ ac: [] });
    const quiet = (): void => undefined;
    const adapter = {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (t: NodeJS.Timeout | undefined) => clearTimeout(t),
        getStateAsync: (id: string) =>
            Promise.resolve(id === 'aircraft.list' && saved.list ? { val: saved.list, ts: 0 } : null),
        delay: (ms: number) => {
            delays.push(ms);
            return Promise.resolve();
        },
    };
    const host = {
        adapter,
        log: { warn: quiet, info: quiet, debug: quiet, error: quiet, silly: quiet, level: 'info' },
        home: HOME,
        stopped: () => false,
        write: (id: string, val: unknown) => {
            writes.set(id, val);
            return Promise.resolve();
        },
        updateConnection: () => Promise.resolve(),
        notify: (event: string, message: string) => {
            notes.push(`${event}|${message}`);
            return Promise.resolve();
        },
    } as unknown as Host;
    const fetchJson = async (url: string): Promise<unknown> => {
        urls.push(url);
        await new Promise(r => setTimeout(r, 5));
        const out = handler(url);
        if (out instanceof Error) {
            throw out;
        }
        return out;
    };
    const mod = new AircraftModule(
        host,
        {
            areaUrl: 'https://area.example/v2/lat/{lat}/lon/{lon}/dist/{radiusNm}',
            lookupUrls: ['https://one.example/hex/{hex}', 'https://two.example/hex/{hex}'],
            routeUrl: '',
            header: null,
            background: { enabled: false, radiusNm: 16, intervalMs: 60_000 },
            overheadEl: 45,
            ...cfg,
        },
        { getJson: fetchJson, getText: () => Promise.resolve('') },
    );
    return { mod, urls, delays, writes, notes, respond: fn => (handler = fn) };
}

describe('aircraft: backoff', () => {
    it('waits at least a minute after a 429, doubling up to 30 minutes, and honours Retry-After', () => {
        expect(backoffMs(1, new HttpError(429))).to.equal(60_000);
        expect(backoffMs(3, new HttpError(429))).to.equal(240_000);
        expect(backoffMs(20, new HttpError(429))).to.equal(30 * 60_000);
        expect(backoffMs(1, new HttpError(429, 600_000))).to.equal(600_000);
    });

    it('backs off other failures from 2 s up to 5 minutes', () => {
        expect(backoffMs(1, new Error('connect ETIMEDOUT'))).to.equal(2_000);
        expect(backoffMs(4, new HttpError(503))).to.equal(16_000);
        expect(backoffMs(30, new Error('x'))).to.equal(5 * 60_000);
    });

    it('reads Retry-After as seconds or as a date', () => {
        const now = Date.UTC(2026, 9, 17, 12);
        expect(retryAfterOf('120', now)).to.equal(120_000);
        expect(retryAfterOf(new Date(now + 90_000).toUTCString(), now)).to.equal(90_000);
        expect(retryAfterOf(null, now)).to.equal(null);
        expect(retryAfterOf('soon', now)).to.equal(null);
    });

    it('leaves a failing lookup source (and its fallback) alone during the backoff', async () => {
        const h = harness();
        h.respond(() => new HttpError(429));
        const fetchFollowed = (
            h.mod as unknown as { fetchFollowed: (hex: string) => Promise<unknown> }
        ).fetchFollowed.bind(h.mod);
        await fetchFollowed('aaaaa1');
        expect(h.urls).to.have.length(2); // the lookup, then the fallback
        for (let i = 0; i < 5; i++) {
            await fetchFollowed('aaaaa1');
        }
        expect(h.urls).to.have.length(2);
        h.mod.stop();
    });
});

describe('aircraft: polling model', () => {
    it('serves concurrent requests with one fetch each, widening the radius, and trims per request', async () => {
        const h = harness();
        h.respond(() => ({ ac: [raw('aaaaa1', 5), raw('aaaaa2', 30), raw('aaaaa3', 80)] }));
        const [small, wide] = await Promise.all([h.mod.aircraft(10), h.mod.aircraft(50)]);
        expect(h.urls.map(u => u.replace(/.*\/dist\//, ''))).to.deep.equal(['10', '50']);
        expect(small).to.have.property('radiusNm', 10);
        expect((wide as { ac: Aircraft[] }).ac.map(a => a.hex)).to.deep.equal(['aaaaa1', 'aaaaa2']);
        // a fresh answer that covers the radius is reused
        const again = await h.mod.aircraft(20);
        expect(h.urls).to.have.length(2);
        expect((again as { ac: Aircraft[] }).ac.map(a => a.hex)).to.deep.equal(['aaaaa1']);
        h.mod.stop();
    });

    it('answers with an error when there is no data at all', async () => {
        const h = harness();
        h.respond(() => new HttpError(429));
        expect(await h.mod.aircraft(10)).to.deep.equal({ error: 'No aircraft data yet' });
        expect(h.mod.area.used).to.equal(true);
        h.mod.stop();
    });

    it('does not ask a failing source again before the backoff ends, and answers from the last data', async () => {
        const h = harness();
        h.respond(() => ({ ac: [raw('aaaaa1', 5)] }));
        await h.mod.aircraft(10);
        h.respond(() => new HttpError(429));
        // make the cached answer stale, then fail once
        (h.mod as unknown as { cache: { at: number } }).cache.at -= 60_000;
        const first = (await h.mod.aircraft(10)) as { ac: Aircraft[] };
        expect(h.urls).to.have.length(2);
        expect(first.ac.map(a => a.hex)).to.deep.equal(['aaaaa1']);
        for (let i = 0; i < 5; i++) {
            await h.mod.aircraft(10);
        }
        expect(h.urls).to.have.length(2); // 429: at least a minute before the next request
        h.mod.stop();
    });

    it('waits for the backoff even when the loop was armed before the failure', async () => {
        const h = harness();
        h.respond(() => new HttpError(429));
        await h.mod.aircraft(10); // fails; the loop is armed for 10 s
        const tick = (h.mod as unknown as { areaTick: () => Promise<void> }).areaTick.bind(h.mod);
        await tick(); // what the armed timer would do
        expect(h.urls).to.have.length(1);
        h.mod.stop();
    });

    it('treats a wrong receiver path (404) or an answer without a list as a failure', async () => {
        const h = harness({ areaUrl: 'http://192.0.2.1/data/aircraft.json' });
        h.respond(() => null);
        expect(await h.mod.aircraft(10)).to.deep.equal({ error: 'No aircraft data yet' });
        const h2 = harness({ areaUrl: 'http://192.0.2.1/' });
        h2.respond(() => ({ hello: 'world' }));
        // a success (even an empty one) would have answered with a list
        expect(await h2.mod.aircraft(10)).to.deep.equal({ error: 'No aircraft data yet' });
        h.mod.stop();
        h2.mod.stop();
    });

    it('notifies once when an aircraft starts reporting an emergency (background polling)', async () => {
        const h = harness({ background: { enabled: true, radiusNm: 16, intervalMs: 60_000 } });
        h.respond(() => ({ ac: [raw('aaaaa1', 5, { squawk: '7700' }), raw('aaaaa2', 8)] }));
        await h.mod.aircraft(10);
        (h.mod as unknown as { cache: { at: number } }).cache.at -= 60_000;
        await h.mod.aircraft(10); // still in an emergency: no second message
        expect(h.notes).to.have.length(1);
        expect(h.notes[0]).to.match(/^aircraftEmergency\|TSTaa1: emergency \(squawk 7700\), 9 km N$/);
        h.mod.stop();
    });

    it('does not report an emergency again after a restart', async () => {
        const h = harness(
            { background: { enabled: true, radiusNm: 16, intervalMs: 60_000 } },
            JSON.stringify([{ hex: 'aaaaa1', emergency: 'emergency' }]),
        );
        await h.mod.start();
        h.respond(() => ({ ac: [raw('aaaaa1', 5, { squawk: '7700' })] }));
        await h.mod.aircraft(10);
        expect(h.notes).to.deep.equal([]);
        h.mod.stop();
    });

    it('uses the local receiver and filters by distance itself', async () => {
        const h = harness({ areaUrl: 'http://192.0.2.1/data/aircraft.json' });
        h.respond(() => ({ aircraft: [raw('aaaaa1', 5), raw('aaaaa2', 30)] }));
        const r = (await h.mod.aircraft(10)) as { ac: Aircraft[] };
        expect(h.urls).to.deep.equal(['http://192.0.2.1/data/aircraft.json']);
        expect(r.ac.map(a => a.hex)).to.deep.equal(['aaaaa1']);
        expect(h.mod.sources.map(s => s.id)).to.deep.equal(['aircraftArea', 'aircraftLookup', 'aircraftLookup2']);
        h.mod.stop();
    });

    it('writes the summary states only with background polling', async () => {
        const h = harness({ background: { enabled: true, radiusNm: 16, intervalMs: 60_000 } });
        h.respond(() => ({ ac: [raw('aaaaa1', 5), raw('aaaaa2', 30)] }));
        await h.mod.aircraft(50);
        expect(h.writes.get('aircraft.count')).to.equal(1); // trimmed to the background radius
        expect(JSON.parse(String(h.writes.get('aircraft.list')))[0]).to.not.have.property('trail');
        h.mod.stop();
    });
});

describe('aircraft: follow', () => {
    it('starts from the last area search without asking again', async () => {
        const h = harness();
        h.respond(() => ({ ac: [raw('aaaaa1', 5, { alt_geom: 30500 })] }));
        await h.mod.aircraft(10);
        const f = await h.mod.follow('aaaaa1');
        expect(h.urls).to.have.length(1);
        expect(f.found).to.equal(true);
        expect(f.ac!.altGeom).to.equal(30500);
        h.mod.stop();
    });

    it('without a lookup URL, follows with the latest area data (never a frozen first answer)', async () => {
        const h = harness({ lookupUrls: [] });
        h.respond(() => ({ ac: [raw('aaaaa1', 5)] }));
        await h.mod.aircraft(10);
        const first = await h.mod.follow('aaaaa1');
        h.respond(() => ({ ac: [raw('aaaaa1', 7)] }));
        (h.mod as unknown as { cache: { at: number } }).cache.at -= 60_000;
        await h.mod.aircraft(10);
        const second = await h.mod.follow('aaaaa1');
        expect(second.ac!.lat).to.be.greaterThan(first.ac!.lat);
        expect(h.urls.every(u => !u.includes('/hex/'))).to.equal(true);
        h.mod.stop();
    });

    it('falls back to the second lookup when the first fails', async () => {
        const h = harness();
        h.respond(url => (url.includes('one.example') ? new Error('timeout') : { ac: [raw('bbbbb1', 100)] }));
        const f = await h.mod.follow('bbbbb1');
        expect(h.urls).to.deep.equal(['https://one.example/hex/bbbbb1', 'https://two.example/hex/bbbbb1']);
        expect(f.found).to.equal(true);
        h.mod.stop();
    });

    it('reports not found (and keeps nothing invented) for an unknown aircraft', async () => {
        const h = harness();
        h.respond(() => ({ ac: [] }));
        const f = await h.mod.follow('ccccc1');
        expect(f).to.include({ found: false, ac: null });
        h.mod.stop();
    });

    it('spaces requests to the primary lookup at least 1.1 s apart', async () => {
        const h = harness();
        h.respond(() => ({ ac: [] }));
        await Promise.all([h.mod.follow('ddddd1'), h.mod.follow('ddddd2')]);
        expect(h.delays).to.have.length(1);
        expect(h.delays[0]).to.be.within(1000, 1100);
        h.mod.stop();
    });
});

describe('aircraft: source URL settings', () => {
    it('accepts http(s) URLs, with placeholders', () => {
        expect(urlSettingOf(' http://192.168.1.20/tar1090/data/aircraft.json ')).to.deep.equal({
            url: 'http://192.168.1.20/tar1090/data/aircraft.json',
        });
        expect(urlSettingOf('https://x.example/lat/{lat}/lon/{lon}').url).to.equal(
            'https://x.example/lat/{lat}/lon/{lon}',
        );
        expect(urlSettingOf('')).to.deep.equal({ url: '' });
        expect(urlSettingOf('mqtt://broker:1883', ['mqtt:', 'mqtts:']).url).to.equal('mqtt://broker:1883');
    });

    it('rejects credentials, other schemes and junk without returning the URL', () => {
        const withPassword = urlSettingOf('http://user:secret@192.168.1.20/data/aircraft.json');
        expect(withPassword.url).to.equal('');
        expect(withPassword.problem).to.not.contain('secret');
        expect(urlSettingOf('ftp://host/aircraft.json').url).to.equal('');
        expect(urlSettingOf('not a url').url).to.equal('');
        expect(urlSettingOf('http://broker', ['mqtt:']).url).to.equal('');
    });
});

describe('aircraft: configured sources', () => {
    it('does nothing without an area source', async () => {
        const h = harness({ areaUrl: '' });
        expect(await h.mod.aircraft(10)).to.deep.equal({ error: 'No aircraft source configured' });
        expect(h.urls).to.deep.equal([]);
        h.mod.stop();
    });

    it('sends the request header only to URLs on the area source host', async () => {
        const seen: [string, Record<string, string> | undefined][] = [];
        const h = harness({
            areaUrl: 'https://one.example/area/{lat}/{lon}/{radiusNm}',
            header: { name: 'X-Api-Key', value: 'k' },
        });
        const m = h.mod as unknown as {
            deps: { getJson: (u: string, t: number, hd?: Record<string, string>) => Promise<unknown> };
        };
        m.deps.getJson = (u, _t, hd) => {
            seen.push([u, hd]);
            return Promise.resolve(
                u.includes('two.example') ? { ac: [raw('ccccc1', 3)] } : Promise.reject(new Error('x')),
            );
        };
        await h.mod.aircraft(10);
        await h.mod.follow('ccccc1');
        expect(seen.find(s => s[0].includes('one.example/area'))![1]).to.deep.equal({ 'X-Api-Key': 'k' });
        expect(seen.find(s => s[0].includes('one.example/hex'))![1]).to.deep.equal({ 'X-Api-Key': 'k' });
        expect(seen.find(s => s[0].includes('two.example'))![1]).to.equal(undefined);
        h.mod.stop();
    });
});
