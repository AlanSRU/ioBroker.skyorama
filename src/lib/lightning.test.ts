import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type { MqttClient } from 'mqtt';
import type { Host } from './host';
import { LightningModule, coverCells, coverTopics, geohash, geohashBox, parseStrike } from './lightning';
import { metres, type Location } from './util';

const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };

/** Points on the circle around home (the cover must contain all of them). */
function ring(home: Location, km: number): [number, number][] {
    const out: [number, number][] = [];
    for (let b = 0; b < 360; b += 10) {
        const d = km / 6371;
        const br = (b * Math.PI) / 180;
        const la1 = (home.lat * Math.PI) / 180;
        const lo1 = (home.lon * Math.PI) / 180;
        const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
        const lo2 =
            lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
        out.push([(la2 * 180) / Math.PI, (((lo2 * 180) / Math.PI + 540) % 360) - 180]);
    }
    return out;
}

describe('lightning: geohash cover', () => {
    it('encodes the reference example', () => {
        expect(geohash(57.64911, 10.40744, 11)).to.equal('u4pruydqqvj');
        const b = geohashBox('u4pruydqqvj');
        expect(57.64911).to.be.within(b.latLo, b.latHi);
        expect(10.40744).to.be.within(b.lonLo, b.lonHi);
    });

    for (const [name, home, km] of [
        ['Edinburgh, 300 km', EDINBURGH, 300],
        ['Edinburgh, 40 km', EDINBURGH, 40],
        ['Fiji, across the date line', { lat: -17.7, lon: 179.9, height: 0 }, 400],
        ['near the North Pole', { lat: 88.5, lon: 20, height: 0 }, 300],
    ] as [string, Location, number][]) {
        it(`covers the whole circle with at most 32 topics: ${name}`, () => {
            const topics = coverTopics(home, km);
            expect(topics.length).to.be.within(1, 32);
            const len = topics[0].split('/').length - 3; // blitzortung/1.1/<chars>/#
            const cells = new Set(coverCells(home, km, len));
            for (const [lat, lon] of [...ring(home, km), ...ring(home, km / 2), [home.lat, home.lon]]) {
                expect(cells.has(geohash(lat, lon, len)), `${lat.toFixed(2)},${lon.toFixed(2)}`).to.equal(true);
            }
        });
    }

    it('writes one geohash character per topic level', () => {
        expect(coverTopics(EDINBURGH, 40)[0]).to.match(/^blitzortung\/1\.1\/([0-9a-z]\/)+#$/);
    });
});

describe('lightning: strikes', () => {
    it('reads a strike (time in ns) and its distance', () => {
        const s = parseStrike('{"time":1760000000123456789,"lat":56.0,"lon":-3.0,"alt":0}', EDINBURGH, 0)!;
        expect(s.t).to.equal(1760000000123);
        expect(s.km).to.be.closeTo(metres(55.95, -3.19, 56, -3) / 1000, 0.1);
        expect(parseStrike('not json', EDINBURGH, 0)).to.equal(null);
        expect(parseStrike('{"lat":"x"}', EDINBURGH, 0)).to.equal(null);
    });
});

class FakeClient extends EventEmitter {
    public subscribed: string[] = [];
    public ended = false;
    public subscribe(topics: string[], cb: (err: Error | null) => void): void {
        this.subscribed = topics;
        cb(null);
    }
    public end(): void {
        this.ended = true;
    }
}

function harness(): {
    mod: LightningModule;
    clients: FakeClient[];
    timeouts: number[];
    writes: { id: string; val: unknown }[];
    publish: () => Promise<void>;
} {
    const clients: FakeClient[] = [];
    const timeouts: number[] = [];
    const writes: { id: string; val: unknown }[] = [];
    const quiet = (): void => undefined;
    const host = {
        adapter: {
            setTimeout: (_fn: () => void, ms: number) => timeouts.push(ms),
            clearTimeout: quiet,
            setInterval: () => undefined,
            clearInterval: quiet,
            getStateAsync: () => Promise.resolve(null),
        },
        log: { warn: quiet, info: quiet, debug: quiet, error: quiet },
        home: EDINBURGH,
        stopped: () => false,
        write: (id: string, val: unknown) => {
            writes.push({ id, val });
            return Promise.resolve();
        },
        updateConnection: () => Promise.resolve(),
    } as unknown as Host;
    const mod = new LightningModule(host, { radiusKm: 300, nearKm: 40 }, () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as MqttClient;
    });
    const publish = (): Promise<void> => (mod as unknown as { publish: () => Promise<void> }).publish();
    return { mod, clients, timeouts, writes, publish };
}

describe('lightning: feed', () => {
    it('is not reachable until it has connected, and subscribes to the cover', async () => {
        const h = harness();
        await h.mod.start();
        expect(h.mod.health.reachable).to.equal(false);
        h.clients[0].emit('connect');
        expect(h.mod.health.reachable).to.equal(true);
        expect(h.clients[0].subscribed).to.deep.equal(coverTopics(EDINBURGH, 300));
    });

    it('reconnects with a growing delay, reset only after a stable connection', async () => {
        const h = harness();
        await h.mod.start();
        h.clients[0].emit('close');
        h.clients[0].emit('close'); // a stale client's close is ignored
        expect(h.timeouts).to.deep.equal([5_000]);
        (h.mod as unknown as { open: () => void }).open();
        h.clients[1].emit('connect');
        h.clients[1].emit('close'); // dropped at once: not stable
        expect(h.timeouts).to.deep.equal([5_000, 10_000]);
        expect(h.clients[0].ended).to.equal(true);
    });

    it('survives a late error from a client stopped while connecting (no unhandled error)', async () => {
        const h = harness();
        await h.mod.start();
        h.mod.stop();
        expect(() => h.clients[0].emit('error', new Error('connack timeout'))).to.not.throw();
        h.clients[0].emit('close');
        expect(h.timeouts).to.deep.equal([]); // no reconnect after stop
    });

    it('counts every strike of a big storm, writing only the newest 1000', async () => {
        const h = harness();
        await h.mod.start();
        const now = Date.now();
        for (let i = 0; i < 25_000; i++) {
            const t = now - 50 * 60_000 + i * 100;
            h.clients[0].emit('message', 'topic', Buffer.from(JSON.stringify({ time: t * 1e6, lat: 56.5, lon: -3.0 })));
        }
        await h.publish();
        expect(h.writes.filter(w => w.id === 'lightning.count1h').pop()!.val).to.equal(25_000);
        const json = JSON.parse(String(h.writes.filter(w => w.id === 'lightning.strikes').pop()!.val));
        expect(json.total).to.equal(25_000);
        expect(json.strikes).to.have.length(1000);
    });

    it('alerts on the first near strike after a quiet spell only', async () => {
        const h = harness();
        await h.mod.start();
        const now = Date.now();
        const strike = (t: number, lat = 56.0): void => {
            h.clients[0].emit('message', 'topic', Buffer.from(JSON.stringify({ time: t * 1e6, lat, lon: -3.0 })));
        };
        strike(now - 40 * 60_000); // 6 km away
        await h.publish();
        strike(now - 35 * 60_000); // 5 min later: same storm
        strike(now - 34 * 60_000, 58.5); // far (≈ 280 km): no alert
        await h.publish();
        strike(now - 2 * 60_000); // after 33 quiet minutes
        await h.publish();
        const alerts = h.writes.filter(w => w.id === 'lightning.alert');
        expect(alerts).to.have.length(2);
        expect(alerts[0].val).to.match(/^Lightning \d+ km [NESW]+$/);
        expect(h.writes.filter(w => w.id === 'lightning.count1h').pop()!.val).to.equal(4);
    });
});
