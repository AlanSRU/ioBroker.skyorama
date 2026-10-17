import { expect } from 'chai';
import { instanceObjects } from '../../io-package.json';
import {
    aircraftObjects,
    astronomyObjects,
    auroraObjects,
    infoObjects,
    lightningObjects,
    satelliteObjects,
    type ObjectDef,
} from './objects';

const all: ObjectDef[] = [
    ...instanceObjects.map(o => ({ id: o._id, obj: o as unknown as ioBroker.SettableObject })),
    ...infoObjects([
        { id: 'celestrak', name: 'CelesTrak' },
        { id: 'adsblol', name: 'adsb.lol' },
        { id: 'adsbfi', name: 'adsb.fi' },
        { id: 'receiver', name: 'Local receiver' },
        { id: 'noaa', name: 'NOAA SWPC' },
        { id: 'openmeteo', name: 'Open-Meteo' },
        { id: 'aurorawatch', name: 'AuroraWatch UK' },
        { id: 'blitzortung', name: 'Blitzortung' },
    ]),
    ...satelliteObjects(),
    ...astronomyObjects(),
    ...aircraftObjects(),
    ...auroraObjects(),
    ...lightningObjects(),
];

/** Roles used, with what the role list (repochecker config_StateRoles.js) requires of them. */
const ROLES: Record<string, { types: string[]; write?: boolean }> = {
    'indicator.connected': { types: ['boolean'], write: false },
    'indicator.reachable': { types: ['boolean'], write: false },
    indicator: { types: ['boolean'], write: false },
    'indicator.alarm': { types: ['boolean'], write: false },
    'value.distance': { types: ['number'], write: false },
    json: { types: ['string'] },
    text: { types: ['string'] },
    value: { types: ['number'], write: false },
    date: { types: ['number', 'string'] },
    'date.start': { types: ['number', 'string'] },
    'date.end': { types: ['number', 'string'] },
};

describe('objects', () => {
    const byId = new Map(all.map(d => [d.id, d.obj]));

    it('has no duplicate ids', () => {
        expect(byId.size).to.equal(all.length);
    });

    it('has a folder/channel/device for every parent of every id (E3009), and states are leaves', () => {
        for (const { id } of all) {
            const parts = id.split('.');
            for (let i = 1; i < parts.length; i++) {
                const parent = byId.get(parts.slice(0, i).join('.'));
                expect(parent, `parent of ${id}`).to.not.equal(undefined);
                expect(['folder', 'channel', 'device'], `parent of ${id}`).to.include(parent!.type);
            }
        }
    });

    it('uses only valid ids', () => {
        for (const { id } of all) {
            expect(id).to.match(/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/);
        }
    });

    it('gives every state a valid role, read-only, and a def where 0 would not be a lie', () => {
        for (const { id, obj } of all) {
            if (obj.type !== 'state') {
                continue;
            }
            const c = obj.common;
            const role = ROLES[c.role];
            expect(role, `role of ${id}`).to.not.equal(undefined);
            expect(role.types, `type of ${id}`).to.include(c.type);
            expect(c.read, `read of ${id}`).to.equal(true);
            expect(c.write, `write of ${id}`).to.equal(false);
            if (c.type === 'string' || c.type === 'boolean') {
                expect(c.def, `def of ${id}`).to.not.equal(undefined);
            }
            if (c.type === 'number') {
                expect(c.def, `def of ${id} (a missing number must stay null)`).to.equal(undefined);
            }
        }
    });

    it('puts a unit on every angle', () => {
        for (const { id, obj } of all) {
            if (/(elevation|azimuth|bearing|maxEl|Az)$/.test(id)) {
                expect((obj.common as ioBroker.StateCommon).unit, id).to.equal('°');
            }
        }
    });
});
