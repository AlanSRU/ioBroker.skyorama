import { expect } from 'chai';
import type { Host } from './host';
import {
    SkyExtrasModule,
    bestHours,
    eclipses,
    forecastHours,
    hourlyRate,
    inWindow,
    meteorShowers,
    nearestPeak,
    nightTimeline,
    skyEvents,
} from './skyevents';
import type { Location } from './util';

const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };

describe('sky extras: meteor showers', () => {
    it('finds the 2024 Perseids peak (IMO: 12 August, 13–16 h UT)', () => {
        const peak = new Date(nearestPeak(140.0, Date.UTC(2024, 7, 1)));
        expect(peak.toISOString().slice(0, 10)).to.equal('2024-08-12');
        expect(peak.getUTCHours()).to.be.within(11, 17);
    });

    it('finds the 2025 Geminids peak (14 December)', () => {
        expect(new Date(nearestPeak(262.2, Date.UTC(2025, 11, 20))).toISOString().slice(0, 10)).to.equal('2025-12-14');
    });

    it('finds a peak a few days ahead (2026 Orionids, 21–22 October)', () => {
        const peak = new Date(nearestPeak(208, Date.UTC(2026, 9, 17, 13, 46)));
        expect(peak.toISOString().slice(0, 10)).to.be.oneOf(['2026-10-21', '2026-10-22']);
    });

    it('knows active windows across the year end', () => {
        expect(inWindow(Date.UTC(2025, 0, 3), '12-28', '01-12')).to.equal(true);
        expect(inWindow(Date.UTC(2024, 11, 30), '12-28', '01-12')).to.equal(true);
        expect(inWindow(Date.UTC(2025, 1, 3), '12-28', '01-12')).to.equal(false);
        expect(inWindow(Date.UTC(2025, 7, 12), '07-17', '08-24')).to.equal(true);
    });

    it('lowers the rate away from the peak, with a low radiant and a bright sky', () => {
        const peak = hourlyRate(100, 0, 90, 6.5);
        expect(peak).to.be.closeTo(100, 0.01);
        expect(hourlyRate(100, 4, 90, 6.5)).to.be.closeTo(10, 0.01);
        expect(hourlyRate(100, 0, 30, 6.5)).to.be.closeTo(50, 0.01);
        expect(hourlyRate(100, 0, 90, 5.5)).to.be.below(peak / 2);
        expect(hourlyRate(100, 0, -5, 6.5)).to.equal(0);
    });

    it('reports the Perseids on peak night from Edinburgh', () => {
        const m = meteorShowers(EDINBURGH, Date.UTC(2024, 7, 12, 12));
        const per = m.active.find(a => a.code === 'PER')!;
        expect(per.rateTonight).to.be.within(10, 100);
        expect(m.text).to.contain('Perseids active');
    });

    it('names the next shower when none is active', () => {
        const m = meteorShowers(EDINBURGH, Date.UTC(2024, 9, 1, 12));
        expect(m.active).to.deep.equal([]);
        expect(m.next!.code).to.equal('ORI');
        const during = meteorShowers(EDINBURGH, Date.UTC(2024, 7, 12, 12));
        expect(during.next!.code).to.not.be.oneOf(during.active.map(a => a.code));
        expect(m.text).to.contain('Next meteor shower: Orionids');
    });
});

describe('sky extras: eclipses', () => {
    it('finds the solar eclipse of 29 March 2025 (about 40 % in Edinburgh)', () => {
        const e = eclipses(EDINBURGH, Date.UTC(2025, 0, 1));
        expect(new Date(e.solar!.peak).toISOString().slice(0, 10)).to.equal('2025-03-29');
        expect(e.solar!.obscuration).to.be.within(30, 50);
    });

    it('skips lunar eclipses with the moon below the horizon (7 Sep 2025, 3 Mar 2026)', () => {
        const e = eclipses(EDINBURGH, Date.UTC(2025, 8, 1));
        expect(new Date(e.lunar!.peak).toISOString().slice(0, 10)).to.equal('2026-08-28');
        expect(e.lunar!.kind).to.equal('partial');
    });
});

describe('sky extras: moon and planet events', () => {
    const events = skyEvents(EDINBURGH, Date.UTC(2024, 8, 1));
    const on = (date: string): string[] =>
        events.filter(e => new Date(e.at).toISOString().startsWith(date)).map(e => e.text);

    it('lists moon phases and the supermoon of 18 September 2024', () => {
        expect(on('2024-09-03')).to.include('New moon');
        expect(on('2024-09-18')).to.include('Full moon (supermoon)');
    });

    it("lists Saturn's opposition of 8 September 2024", () => {
        expect(on('2024-09-08').join()).to.contain('Saturn at opposition');
    });

    it('lists the moon close to Saturn on 17 September 2024', () => {
        expect(on('2024-09-17').join()).to.match(/Moon \d\.\d° from Saturn/);
    });

    it('is sorted and stays within 30 days', () => {
        const at = events.map(e => e.at);
        expect(at).to.deep.equal([...at].sort((a, b) => a - b));
        expect(Math.max(...at)).to.be.below(Date.UTC(2024, 9, 1, 1));
    });
});

describe('sky extras: night timeline', () => {
    it('runs from before sunset to after sunrise, in the evening and after midnight alike', () => {
        for (const now of [Date.UTC(2024, 11, 1, 14), Date.UTC(2024, 11, 2, 2)]) {
            const n = nightTimeline(EDINBURGH, now);
            expect(new Date(n.from).toISOString().slice(0, 13)).to.equal('2024-12-01T15');
            expect(n.sun[0]).to.be.above(0);
            expect(n.sun[n.sun.length - 1]).to.be.above(0);
            expect(Math.min(...n.sun)).to.be.below(-50);
            expect(n.planets.map(p => p.name)).to.deep.equal(['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']);
            expect(n.moon).to.have.length(n.sun.length);
        }
    });

    it('covers the next 18 hours in polar night', () => {
        const now = Date.UTC(2024, 11, 21, 12);
        const n = nightTimeline({ lat: 78.2, lon: 15.6, height: 0 }, now);
        expect(n.to - now).to.equal(18 * 3600_000);
    });
});

describe('sky extras: stargazing forecast', () => {
    // a winter night in Edinburgh, new moon (1 Dec 2024): 18:00 to 06:00 UTC is dark
    const start = Date.UTC(2024, 11, 1, 12) / 1000;
    const cloud = [90, 90, 90, 90, 90, 90, 80, 50, 20, 10, 10, 15, 60, 90, 90, 90, 90, 90, 90, 90];
    const data = {
        hourly: {
            time: cloud.map((_, i) => start + i * 3600),
            cloud_cover: cloud,
            cloud_cover_low: cloud,
            cloud_cover_mid: cloud.map(() => 0),
            cloud_cover_high: cloud.map(() => 0),
        },
    };

    it('reads the Open-Meteo answer and scores dark hours only', () => {
        const hours = forecastHours(data, EDINBURGH);
        expect(hours).to.have.length(20);
        expect(hours[0].dark).to.equal(false);
        expect(hours[0].score).to.equal(0);
        const clear = hours.find(h => h.t === (start + 9 * 3600) * 1000)!;
        expect(clear.dark).to.equal(true);
        expect(clear.score).to.be.within(80, 90);
    });

    it('finds the clear stretch', () => {
        const text = bestHours(forecastHours(data, EDINBURGH), EDINBURGH, start * 1000);
        expect(text).to.match(/^Best for stargazing tonight: .*20:00–00:00, about 14 % cloud$/);
    });

    it('says when it stays cloudy', () => {
        const grey = { hourly: { ...data.hourly, cloud_cover: cloud.map(() => 85) } };
        expect(bestHours(forecastHours(grey, EDINBURGH), EDINBURGH, start * 1000)).to.equal(
            'Cloudy tonight (at least 85 % cloud)',
        );
    });

    it('ignores answers it does not understand', () => {
        expect(forecastHours(null, EDINBURGH)).to.deep.equal([]);
        expect(forecastHours({ hourly: { time: 'x' } }, EDINBURGH)).to.deep.equal([]);
    });
});

describe('sky extras: module', () => {
    const quiet = (): void => undefined;
    const make = (fetched: string[], writes: Map<string, unknown>): Host =>
        ({
            adapter: { setTimeout: () => undefined, clearTimeout: quiet, delay: () => Promise.resolve() },
            log: { warn: quiet, info: quiet, debug: quiet, error: quiet },
            home: EDINBURGH,
            stopped: () => false,
            write: (id: string, val: unknown) => {
                writes.set(id, val);
                return Promise.resolve();
            },
            updateConnection: () => Promise.resolve(),
            notify: () => Promise.resolve(),
        }) as unknown as Host;

    it('writes the events without the forecast when it is off', async () => {
        const fetched: string[] = [];
        const writes = new Map<string, unknown>();
        let changed = 0;
        const mod = new SkyExtrasModule(
            make(fetched, writes),
            false,
            () => changed++,
            url => {
                fetched.push(url);
                return Promise.resolve(null);
            },
        );
        await mod.start();
        expect(mod.health).to.equal(null);
        expect(fetched).to.deep.equal([]);
        expect([...writes.keys()]).to.include.members(['astronomy.meteors', 'astronomy.eclipses', 'astronomy.events']);
        expect(writes.has('astronomy.forecast')).to.equal(false);
        expect(mod.latest.events.length).to.be.above(3);
        expect(changed).to.equal(1);
    });

    it('fetches the forecast when it is due, and marks the source failed on a bad answer', async () => {
        const fetched: string[] = [];
        const writes = new Map<string, unknown>();
        const mod = new SkyExtrasModule(make(fetched, writes), true, quiet, url => {
            fetched.push(url);
            return Promise.resolve({ nonsense: true });
        });
        (mod as unknown as { nextForecast: number }).nextForecast = 0;
        await mod.start();
        expect(fetched).to.have.length(1);
        expect(fetched[0]).to.match(
            /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=55\.950&longitude=-3\.190&/,
        );
        expect(writes.has('astronomy.forecast')).to.equal(false);
        expect(mod.health!.used).to.equal(true);
    });
});
