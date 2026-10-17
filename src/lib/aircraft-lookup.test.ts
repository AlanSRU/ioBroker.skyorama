import { expect } from 'chai';
import {
    AircraftLookup,
    airlineOf,
    csvFields,
    parseAirlines,
    photoFrom,
    plausible,
    routeFrom,
    shortName,
} from './aircraft-lookup';

const EDI = { lat: 55.95, lon: -3.37 };
const LHR = { lat: 51.47, lon: -0.45 };
const ROUTE = {
    _airports: [
        { iata: 'EDI', icao: 'EGPH', name: 'Edinburgh Airport', location: 'Edinburgh', ...EDI },
        { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow Airport', location: 'London', ...LHR },
    ],
};

describe('aircraft lookup: parsing', () => {
    it('splits CSV with quoted commas and doubled quotes', () => {
        expect(csvFields('a,"b, c","say ""hi""",')).to.deep.equal(['a', 'b, c', 'say "hi"', '']);
    });

    it('reads the airline list and names airline callsigns only', () => {
        const map = parseAirlines('Code,Name,ICAO,IATA\n1,"British Airways, Plc",BAW,BA\n2,Bad,BA,X\n');
        expect(map.get('BAW')).to.equal('British Airways, Plc');
        expect(map.size).to.equal(1);
        expect(airlineOf('BAW123', map)).to.equal('British Airways, Plc');
        expect(airlineOf('GABCD', map)).to.equal(null);
        expect(airlineOf('BAW123', null)).to.equal(null);
    });

    it('shortens airport names', () => {
        expect(shortName('Edinburgh International Airport')).to.equal('Edinburgh');
        expect(shortName(undefined)).to.equal('');
    });

    it('checks that the aircraft is on the way', () => {
        expect(plausible(54, -2, EDI, LHR)).to.equal(true);
        expect(plausible(60, 10, EDI, LHR)).to.equal(false);
    });

    it('builds a route from the first and last airport', () => {
        const r = routeFrom(ROUTE, 54, -2)!;
        expect(r).to.include({ from: 'EDI', to: 'LHR', fromName: 'Edinburgh', toName: 'London', plausible: true });
        expect(routeFrom({ _airports: [ROUTE._airports[0]] }, null, null)).to.equal(null);
        expect(routeFrom(null, null, null)).to.equal(null);
    });

    it('takes the first photo with its photographer and link', () => {
        const p = photoFrom({
            photos: [{ thumbnail_large: { src: 'https://x/1.jpg' }, link: 'https://x/1', photographer: 'A. B.' }],
        });
        expect(p).to.deep.equal({ src: 'https://x/1.jpg', link: 'https://x/1', by: 'A. B.' });
        expect(photoFrom({ photos: [] })).to.equal(null);
    });
});

describe('aircraft lookup: caching', () => {
    const quiet = { warn: () => undefined, info: () => undefined, debug: () => undefined };

    it('caches answers, "nothing known" too, but not errors', async () => {
        const urls: string[] = [];
        let fail = true;
        const lookup = new AircraftLookup(
            quiet,
            url => {
                urls.push(url);
                if (url.includes('/routes/') && fail) {
                    return Promise.reject(new Error('timeout'));
                }
                return Promise.resolve(url.includes('/routes/') ? ROUTE : null);
            },
            () => Promise.resolve('Code,Name,ICAO\n1,British Airways,BAW\n'),
        );
        const q = { hex: 'abc123', flight: 'BAW123', reg: 'G-ABCD', lat: 54, lon: -2 };
        const first = await lookup.lookup(q);
        expect(first.route).to.equal(null); // error: not cached
        expect(first.photo).to.equal(null); // 404 by hex and by reg: cached as none
        expect(first.airline).to.equal('British Airways');
        fail = false;
        const second = await lookup.lookup({ ...q, lat: 60, lon: 10 });
        expect(second.route).to.include({ from: 'EDI', plausible: false });
        const photoCalls = urls.filter(u => u.includes('planespotters'));
        expect(photoCalls).to.have.length(2); // hex + reg, once
        await lookup.lookup(q);
        expect(urls.filter(u => u.includes('/routes/'))).to.have.length(2);
    });
});
