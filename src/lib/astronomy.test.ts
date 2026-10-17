import { expect } from 'chai';
import * as Astro from 'astronomy-engine';
import { darkWindow, darkness, moonPhaseName, nextRiseSet, sunAltitude, tonight } from './astronomy';
import type { Pass } from './satellites';
import type { Location } from './util';

const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };
const TROMSO: Location = { lat: 69.65, lon: 18.96, height: 0 };

describe('astronomy: sun', () => {
    it('matches the noon altitude at the winter solstice (90 − lat − 23.44)', () => {
        const noon = Date.UTC(2024, 11, 21, 12, 13);
        expect(sunAltitude(EDINBURGH, noon)).to.be.closeTo(90 - 55.95 - 23.44, 0.5);
    });

    it('classifies darkness by sun altitude', () => {
        expect(darkness(10)).to.equal('day');
        expect(darkness(-0.5)).to.equal('day');
        expect(darkness(-3)).to.equal('civil');
        expect(darkness(-9)).to.equal('nautical');
        expect(darkness(-15)).to.equal('astronomical');
        expect(darkness(-25)).to.equal('night');
    });

    it('finds the evening dark window in winter', () => {
        const w = darkWindow(EDINBURGH, Date.UTC(2024, 11, 21, 12, 0))!;
        const from = new Date(w.from);
        expect(from.getUTCHours()).to.be.within(16, 17);
        expect((w.to - w.from) / 3600_000).to.be.within(14, 16);
    });

    it('measures the sun the same way as the dusk/dawn search (no refraction)', () => {
        const w = darkWindow(EDINBURGH, Date.UTC(2026, 9, 17, 12, 0))!;
        expect(sunAltitude(EDINBURGH, w.from)).to.be.closeTo(-6, 0.02);
        expect(sunAltitude(EDINBURGH, w.to)).to.be.closeTo(-6, 0.02);
        // a minute after dusk the window is tonight's, not tomorrow's
        expect(darkWindow(EDINBURGH, w.from + 60_000)!.to).to.equal(w.to);
    });

    it('ends "day" at sunset', () => {
        const set = Astro.SearchRiseSet(
            Astro.Body.Sun,
            new Astro.Observer(55.95, -3.19, 0),
            -1,
            new Date(Date.UTC(2026, 9, 17, 12)),
            1,
        )!;
        expect(darkness(sunAltitude(EDINBURGH, set.date.getTime() - 60_000))).to.equal('day');
        expect(darkness(sunAltitude(EDINBURGH, set.date.getTime() + 60_000))).to.equal('civil');
    });

    it('starts the window now when it is already dark', () => {
        const now = Date.UTC(2024, 11, 21, 23, 0);
        expect(darkWindow(EDINBURGH, now)!.from).to.equal(now);
    });

    it('has no dark window under the midnight sun', () => {
        expect(darkWindow(TROMSO, Date.UTC(2024, 5, 21, 12, 0))).to.equal(null);
    });
});

describe('astronomy: moon', () => {
    it('names the phase', () => {
        expect(moonPhaseName(0)).to.equal('new moon');
        expect(moonPhaseName(90)).to.equal('first quarter');
        expect(moonPhaseName(180)).to.equal('full moon');
        expect(moonPhaseName(359)).to.equal('new moon');
        // full moon of 2024-01-25 17:54 UTC
        expect(moonPhaseName(Astro.MoonPhase(new Date(Date.UTC(2024, 0, 25, 17, 54))))).to.equal('full moon');
    });

    it('gives the next rise and set after now', () => {
        const now = Date.UTC(2024, 0, 25, 12, 0);
        const rs = nextRiseSet(Astro.Body.Moon, EDINBURGH, now);
        expect(rs.rise).to.be.a('number').greaterThan(now);
        expect(rs.set).to.be.a('number').greaterThan(now);
    });
});

describe('astronomy: tonight', () => {
    it('lists planets, deep-sky objects and passes in the dark window', () => {
        const now = Date.UTC(2024, 11, 21, 12, 0);
        const w = darkWindow(EDINBURGH, now)!;
        const p: Pass = {
            sat: 'ISS',
            rise: w.from + 3600_000,
            set: w.from + 3900_000,
            start: w.from + 3660_000,
            end: w.from + 3840_000,
            maxEl: 60,
            maxAt: w.from + 3750_000,
            maxAz: 180,
            fromAz: 250,
            toAz: 100,
        };
        const n = tonight(EDINBURGH, now, [p]);
        // December 2024: Jupiter, Saturn, Venus and Mars all up in the evening
        expect(n.planets.map(x => x.name)).to.include.members(['Jupiter', 'Saturn']);
        expect(n.deepSky.map(x => x.name)).to.include('Andromeda Galaxy');
        expect(n.deepSky.map(x => x.name)).to.not.include('Large Magellanic Cloud');
        expect(n.passes).to.have.length(1);
        expect(n.text).to.match(/^Dark from \d\d:\d\d to /);
        expect(n.text).to.contain('Space stations: ISS');
    });

    it('says so when there is no darkness', () => {
        expect(tonight(TROMSO, Date.UTC(2024, 5, 21, 12, 0), []).text).to.equal('No darkness tonight.');
    });
});
