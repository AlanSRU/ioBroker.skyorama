import { expect } from 'chai';
import * as sat from 'satellite.js';
import { sunAltitude } from './astronomy';
import {
    catalogueNumber,
    dueAlerts,
    groupList,
    lookAt,
    mergeGroups,
    parseTle,
    passText,
    predictPasses,
    sunlit,
    type Pass,
    type Tle,
} from './satellites';
import type { Location } from './util';

// ISS elements of 2019-06-05 12:13 UTC (the satellite.js README example).
const ISS: Tle = [
    'ISS (ZARYA)',
    '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992',
    '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442',
];
const EPOCH = Date.UTC(2019, 5, 5, 12, 13, 0);
const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };

function pass(over: Partial<Pass>): Pass {
    return {
        sat: 'ISS',
        rise: 0,
        set: 0,
        start: 0,
        end: 0,
        maxEl: 40,
        maxAt: 0,
        maxAz: 180,
        fromAz: 270,
        toAz: 90,
        ...over,
    };
}

describe('satellites: orbit data', () => {
    it('parses 3-line TLE text and skips junk', () => {
        const text = `${ISS.join('\r\n')}\r\nNo GP data found\n${ISS.join('\n')}\n`;
        const out = parseTle(text);
        expect(out).to.have.length(2);
        expect(out[0]).to.deep.equal(ISS);
    });

    it('returns nothing for a plain-text error answer', () => {
        expect(parseTle('Invalid query: "GROUP=nope"')).to.deep.equal([]);
    });

    it('keeps only the stations from the stations group and deduplicates', () => {
        const module: Tle = ['ISS (NAUKA)', ISS[1].replace('25544', '49044'), ISS[2].replace('25544', '49044')];
        const out = mergeGroups([
            { group: 'stations', sats: [ISS, module] },
            { group: 'visual', sats: [ISS, module] },
        ]);
        expect(out.map(t => catalogueNumber(t[1]))).to.deep.equal(['25544', '49044']);
    });

    it('always includes stations and drops invalid group names', () => {
        expect(groupList('visual, Weather;bad name!,visual')).to.deep.equal(['stations', 'visual', 'weather', 'bad']);
        expect(groupList(undefined)).to.deep.equal(['stations']);
        expect(groupList('../x?y=1')).to.deep.equal(['stations']);
    });
});

describe('satellites: geometry', () => {
    const sun = [1, 0, 0];
    it('is lit on the sun side and beside the shadow cylinder', () => {
        expect(sunlit({ x: 7000, y: 0, z: 0 }, sun)).to.equal(true);
        expect(sunlit({ x: -7000, y: 7000, z: 0 }, sun)).to.equal(true);
    });
    it('is dark inside the earth shadow', () => {
        expect(sunlit({ x: -7000, y: 100, z: 0 }, sun)).to.equal(false);
    });
});

describe('satellites: pass prediction (ISS over Edinburgh, late May 2019)', () => {
    const rec = sat.twoline2satrec(ISS[1], ISS[2]);
    // Visible passes come in runs of several days; over Edinburgh one ran until ~6 days before this epoch.
    const from = EPOCH - 10 * 86400_000;
    const passes = predictPasses('ISS', rec, EDINBURGH, from, 72, t => sunAltitude(EDINBURGH, t));

    it('finds the visible passes of a visibility run', () => {
        expect(passes.length).to.be.at.least(3);
    });

    it('finds none in a run of daytime-only passes', () => {
        expect(predictPasses('ISS', rec, EDINBURGH, EPOCH, 72, t => sunAltitude(EDINBURGH, t))).to.deep.equal([]);
    });

    it('gives consistent times and angles for every pass', () => {
        for (const p of passes) {
            expect(p.rise).to.be.at.most(p.start);
            expect(p.start).to.be.at.most(p.maxAt);
            expect(p.maxAt).to.be.at.most(p.end);
            expect(p.end).to.be.at.most(p.set);
            expect(p.set - p.rise).to.be.below(15 * 60_000);
            expect(p.maxEl).to.be.within(10, 90);
            expect(sunAltitude(EDINBURGH, p.start)).to.be.below(-6);
            const atMax = lookAt(rec, EDINBURGH, p.maxAt);
            expect(atMax!.el).to.be.closeTo(p.maxEl, 1e-9);
            expect(atMax!.lit).to.equal(true);
        }
    });

    it('spaces passes by about whole orbits (~93 min)', () => {
        for (let i = 1; i < passes.length; i++) {
            const gap = (passes[i].rise - passes[i - 1].rise) / 60_000;
            expect(gap).to.be.greaterThan(80);
        }
    });

    it('returns null for a satellite that cannot be propagated', () => {
        const decayed = sat.twoline2satrec(ISS[1], ISS[2]);
        // far beyond what the elements can describe: the orbit decays in the model
        expect(lookAt(decayed, EDINBURGH, EPOCH + 20 * 365 * 86400_000)).to.equal(null);
    });
});

describe('satellites: alerts', () => {
    const now = Date.UTC(2026, 0, 1, 20, 0, 0);
    it('alerts within the lead time, for passes high enough, once', () => {
        const passes = [
            pass({ start: now + 9 * 60_000 }),
            pass({ start: now + 11 * 60_000 }),
            pass({ start: now + 5 * 60_000, maxEl: 12 }),
            pass({ start: now - 60_000 }),
        ];
        expect(dueAlerts(passes, now, 10, 20, [])).to.deep.equal([passes[0]]);
        // re-planning moved the same pass by one step: still alerted
        const moved = [pass({ start: now + 9 * 60_000 + 20_000 })];
        expect(dueAlerts(moved, now, 10, 20, [{ sat: 'ISS', start: now + 9 * 60_000 }])).to.deep.equal([]);
        // another station at the same time is a different pass
        const other = [pass({ sat: 'Tiangong', start: now + 9 * 60_000 })];
        expect(dueAlerts(other, now, 10, 20, [{ sat: 'ISS', start: now + 9 * 60_000 }])).to.have.length(1);
    });

    it('describes a pass in one line', () => {
        const p = pass({ start: now + 60_000, end: now + 5 * 60_000, maxAt: now + 3 * 60_000, maxEl: 54.4 });
        expect(passText(p, now)).to.match(
            /^ISS visible from \d\d:\d\d for 4 min: from the W, highest 54° in the S at \d\d:\d\d, towards the E$/,
        );
    });
});
