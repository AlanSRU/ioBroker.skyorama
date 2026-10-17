import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as Astro from 'astronomy-engine';
import * as sat from 'satellite.js';
import { SatrecCache, skyNow } from './sky';
import type { Tle } from './satellites';
import type { Location } from './util';

const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };
const ISS: Tle = [
    'ISS (ZARYA)',
    '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992',
    '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442',
];

/** The dome page's drawing code, loaded as the browser would (it registers itself on `window`). */
interface DomeStatics {
    horizontal(raH: number, dec: number, lat: number, lstH: number): { az: number; el: number };
    limitingMag(sun: number, moon?: { el: number; lit: number }): number;
    skyColours(sun: number): [string, string];
    separation(a: { az: number; el: number }, b: { az: number; el: number }): number;
    towards(a: { az: number; el: number }, b: { az: number; el: number }, deg: number): { az: number; el: number };
}
function loadDome(): DomeStatics {
    const window: Record<string, unknown> = {};
    runInNewContext(readFileSync(join(__dirname, '../../www/js/dome.js'), 'utf8'), { window });
    return window.SkyoramaDome as DomeStatics;
}

describe('sky: the dome answer', () => {
    it('gives the sun, moon, planets and satellites above the horizon', () => {
        const cache = new SatrecCache();
        const at = Date.UTC(2019, 5, 5, 12, 13);
        // a home under the ISS at that moment, so it is high up
        const rec = sat.twoline2satrec(ISS[1], ISS[2]);
        const pv = sat.propagate(rec, new Date(at))!;
        const geo = sat.eciToGeodetic(pv.position, sat.gstime(sat.jday(new Date(at))));
        const home: Location = { lat: sat.degreesLat(geo.latitude), lon: sat.degreesLong(geo.longitude), height: 0 };
        const s = skyNow(home, at, cache.get([ISS], 1), ['25544']);
        expect(s.planets.map(p => p.name)).to.deep.equal(['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']);
        expect(s.moon.lit).to.be.within(0, 1);
        expect(s.satellites).to.have.length(1);
        expect(s.satellites[0]).to.include({ id: '25544', name: 'ISS', tracked: true });
        expect(s.satellites[0].el).to.be.greaterThan(80);
    });

    it('reuses parsed orbits until the orbit set changes', () => {
        const cache = new SatrecCache();
        const a = cache.get([ISS], 1);
        expect(cache.get([ISS], 1)).to.equal(a);
        expect(cache.get([ISS], 2)).to.not.equal(a);
    });
});

describe('sky: the dome page', () => {
    const dome = loadDome();

    it('places stars where astronomy-engine does', () => {
        // Vega (J2000) over Edinburgh at 2026-10-17 21:00 UTC; both without refraction
        const t = new Date(Date.UTC(2026, 9, 17, 21, 0));
        const d = t.getTime() / 86400000 + 2440587.5 - 2451545.0;
        const lstH = (((18.697374558 + 24.06570982441908 * d + EDINBURGH.lon / 15) % 24) + 24) % 24;
        const ours = dome.horizontal(18.6156, 38.7837, EDINBURGH.lat, lstH);
        const ref = Astro.Horizon(t, new Astro.Observer(EDINBURGH.lat, EDINBURGH.lon, 0), 18.6156, 38.7837);
        expect(ours.el).to.be.closeTo(ref.altitude, 0.5);
        expect(ours.az).to.be.closeTo(ref.azimuth, 0.5);
    });

    it('shows no stars by day, more as it gets dark, fewer under a bright moon', () => {
        expect(dome.limitingMag(20)).to.be.below(-2);
        expect(dome.limitingMag(-6)).to.be.within(1, 2);
        expect(dome.limitingMag(-20)).to.be.at.least(5);
        const fullMoonHigh = dome.limitingMag(-20, { el: 50, lit: 1 });
        expect(dome.limitingMag(-20) - fullMoonHigh).to.be.closeTo(1.8, 0.01);
        expect(dome.limitingMag(-20, { el: -10, lit: 1 })).to.equal(dome.limitingMag(-20)); // moon down
    });

    it('measures angles across the sky (for the sun glare that hides planets)', () => {
        expect(dome.separation({ az: 180, el: 20 }, { az: 180, el: 35 })).to.be.closeTo(15, 1e-9);
        expect(dome.separation({ az: 359, el: 0 }, { az: 1, el: 0 })).to.be.closeTo(2, 1e-9);
        expect(dome.separation({ az: 0, el: 90 }, { az: 123, el: 80 })).to.be.closeTo(10, 1e-9);
    });

    it('steps along the great circle towards the sun, also when it is below the horizon', () => {
        // moon low in the SSW, sun 39° below the NW horizon: the step goes down and to the west
        const moon = { az: 200, el: 10 };
        const sun = { az: 315, el: -39 };
        const p = dome.towards(moon, sun, 0.5);
        expect(dome.separation(moon, p)).to.be.closeTo(0.5, 1e-6);
        expect(dome.separation(p, sun)).to.be.closeTo(dome.separation(moon, sun) - 0.5, 1e-6);
        expect(p.el).to.be.below(moon.el);
        expect(p.az).to.be.above(moon.az);
    });

    it('colours the sky black at night and blue by day', () => {
        expect(dome.skyColours(-25)).to.deep.equal(['#000000', '#020309']);
        const [zenith] = dome.skyColours(30);
        const [r, g, b] = zenith.match(/\d+/g)!.map(Number);
        expect(b).to.be.greaterThan(r + 100);
        expect(b).to.be.greaterThan(g);
    });
});
