import { expect } from 'chai';
import { auroraWatchLevel, cloudCover, decide, ovationAround, type AuroraInputs } from './aurora';
import type { Location } from './util';

const EDINBURGH: Location = { lat: 55.95, lon: -3.19, height: 0 };

describe('aurora: OVATION grid', () => {
    it('reads the cells along home longitude: here, near (within 3°) and the peak', () => {
        // home rounds to 56°N, 357° (±1°)
        const grid = {
            'Forecast Time': '2026-10-17T21:10:00Z',
            coordinates: [
                [357, 56, 2],
                [356, 58, 12],
                [358, 60, 30],
                [357, 64, 80],
                [10, 58, 99], // other longitude
                [357, 52, 50], // 4° equatorward: not "near"
            ],
        };
        expect(ovationAround(grid, EDINBURGH)).to.deep.equal({
            lat: 56,
            here: 2,
            near: 12,
            nearLat: 58,
            peak: 80,
            peakLat: 64,
            forecastAt: '2026-10-17T21:10:00Z',
        });
    });

    it('looks south in the southern hemisphere', () => {
        const home: Location = { lat: -45.9, lon: 170.5, height: 0 };
        const grid = {
            coordinates: [
                [171, -46, 1],
                [170, -48, 15],
                [171, -42, 90], // 4° equatorward: not near,
            ],
        };
        const o = ovationAround(grid, home)!;
        expect(o.near).to.equal(15);
        expect(o.nearLat).to.equal(-48);
    });

    it('sees the aurora south of a high-latitude home (under the oval)', () => {
        // Tromsø during a storm: the oval at 65–67°N, south of home
        const home: Location = { lat: 69.65, lon: 18.96, height: 0 };
        const grid = {
            coordinates: [
                [19, 65, 60],
                [19, 67, 24],
                [19, 68, 8],
                [19, 70, 1],
            ],
        };
        const o = ovationAround(grid, home)!;
        expect(o).to.include({ lat: 70, near: 24, nearLat: 67, peak: 60, peakLat: 65 });
        const v = decide({
            sunAlt: -20,
            ovation: o,
            cloud: 10,
            auroraWatch: null,
            kp: null,
            cloudLimit: 60,
            north: true,
        });
        expect(v.possible).to.equal(true);
        expect(v.summary).to.equal('Possible from home: 24 % within 3° south, 10 % cloud. Look south.');
    });

    it('says "overhead" when the strongest nearby cell is home itself', () => {
        const o = ovationAround(
            {
                coordinates: [
                    [357, 56, 30],
                    [357, 57, 20],
                ],
            },
            EDINBURGH,
        )!;
        expect(
            decide({ sunAlt: -20, ovation: o, cloud: 0, auroraWatch: null, kp: null, cloudLimit: 60, north: true })
                .summary,
        ).to.contain('30 % overhead, 0 % cloud. Look up.');
    });

    it('wraps longitude around 0°', () => {
        const home: Location = { lat: 51.48, lon: -0.4, height: 0 };
        const grid = {
            coordinates: [
                [359, 52, 3],
                [1, 54, 11],
            ],
        };
        expect(ovationAround(grid, home)!.near).to.equal(11);
    });

    it('returns null for an answer without a grid', () => {
        expect(ovationAround({}, EDINBURGH)).to.equal(null);
        expect(ovationAround(null, EDINBURGH)).to.equal(null);
    });
});

describe('aurora: other sources', () => {
    it('reads the AuroraWatch UK level', () => {
        expect(auroraWatchLevel('<current_status><site_status status_id="amber" /></current_status>')).to.equal(
            'amber',
        );
        expect(auroraWatchLevel('<x status_id="purple"/>')).to.equal(null);
    });

    it('reads Open-Meteo cloud cover, keeping a real 0', () => {
        expect(cloudCover({ current: { cloud_cover: 0 } })).to.equal(0);
        expect(cloudCover({ current: {} })).to.equal(null);
    });
});

describe('aurora: decision', () => {
    const base: AuroraInputs = {
        sunAlt: -20,
        ovation: { lat: 56, here: 2, near: 14, nearLat: 58, peak: 40, peakLat: 63, forecastAt: null },
        cloud: 20,
        auroraWatch: null,
        kp: 5.33,
        cloudLimit: 60,
        north: true,
    };

    it('is possible when dark, near enough and clear', () => {
        const v = decide(base);
        expect(v.possible).to.equal(true);
        expect(v.summary).to.equal('Possible from home: 14 % within 3° north, 20 % cloud (Kp 5.3). Look north.');
    });

    it('needs the sun below −12°', () => {
        const v = decide({ ...base, sunAlt: -10 });
        expect(v.possible).to.equal(false);
        expect(v.reason).to.equal('not dark');
    });

    it('treats unknown cloud as not clear', () => {
        expect(decide({ ...base, cloud: null }).reason).to.equal('cloud cover unknown');
        expect(decide({ ...base, cloud: 60 }).reason).to.equal('60 % cloud');
    });

    it('accepts AuroraWatch UK amber or red instead of OVATION', () => {
        const far = { ...base, ovation: { ...base.ovation!, near: 3 } };
        expect(decide(far).reason).to.match(/^aurora too far away \(strongest near 63°N, 2 % here\)$/);
        expect(decide({ ...far, auroraWatch: 'red' }).summary).to.contain('AuroraWatch UK red');
        expect(decide({ ...far, auroraWatch: 'yellow' }).possible).to.equal(false);
    });

    it('says so when there is no aurora data, and looks south in the south', () => {
        expect(decide({ ...base, ovation: null, kp: null }).summary).to.equal(
            'Unlikely from home: no recent aurora data',
        );
        const south = { lat: -46, here: 1, near: 15, nearLat: -48, peak: 40, peakLat: -60, forecastAt: null };
        expect(decide({ ...base, ovation: south, north: false }).summary).to.contain('Look south.');
    });
});
