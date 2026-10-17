// Every object the adapter creates, per module. Kept in one place so a unit test can check the tree.

import { DARKNESS_LABELS, PLANETS } from './astronomy';

export interface ObjectDef {
    id: string;
    obj: ioBroker.SettableObject;
}

type StateCommon = Partial<ioBroker.StateCommon>;

function channel(id: string, name: string): ObjectDef {
    return { id, obj: { type: 'channel', common: { name }, native: {} } };
}

function state(id: string, common: StateCommon & { name: string; type: ioBroker.CommonType; role: string }): ObjectDef {
    return { id, obj: { type: 'state', common: { read: true, write: false, ...common }, native: {} } };
}

const json = (id: string, name: string, def: string): ObjectDef =>
    state(id, { name, type: 'string', role: 'json', def });
const text = (id: string, name: string): ObjectDef => state(id, { name, type: 'string', role: 'text', def: '' });
const flag = (id: string, name: string): ObjectDef =>
    state(id, { name, type: 'boolean', role: 'indicator', def: false });
const time = (id: string, name: string, role = 'date'): ObjectDef => state(id, { name, type: 'number', role });
const degrees = (id: string, name: string, min: number, max: number): ObjectDef =>
    state(id, { name, type: 'number', role: 'value', unit: '°', min, max });

/** One `info.<id>` reachability state per data source in use. */
export function infoObjects(sources: { id: string; name: string }[]): ObjectDef[] {
    return sources.map(s =>
        state(`info.${s.id}`, {
            name: `${s.name} reachable`,
            type: 'boolean',
            role: 'indicator.reachable',
            def: false,
        }),
    );
}

/** The background summary states (only written while background polling is on). */
export function aircraftObjects(): ObjectDef[] {
    const value = (id: string, name: string, unit: string, role = 'value'): ObjectDef =>
        state(id, { name, type: 'number', role, unit });
    return [
        channel('aircraft', 'Aircraft'),
        state('aircraft.count', { name: 'Aircraft within the radius', type: 'number', role: 'value' }),
        flag('aircraft.overhead', 'Aircraft overhead'),
        state('aircraft.emergency', {
            name: 'Aircraft in an emergency',
            type: 'boolean',
            role: 'indicator.alarm',
            def: false,
        }),
        text('aircraft.emergencyText', 'Emergency description'),
        json('aircraft.list', 'Aircraft within the radius (JSON)', '[]'),
        channel('aircraft.nearest', 'Nearest airborne aircraft'),
        text('aircraft.nearest.callsign', 'Callsign'),
        text('aircraft.nearest.type', 'Aircraft type'),
        text('aircraft.nearest.registration', 'Registration'),
        value('aircraft.nearest.altitude', 'Altitude', 'ft'),
        value('aircraft.nearest.distance', 'Distance', 'km', 'value.distance'),
        degrees('aircraft.nearest.bearing', 'Bearing from home', 0, 360),
        degrees('aircraft.nearest.elevation', 'Elevation above the horizon', 0, 90),
    ];
}

/** `tracked`: object id under `satellites.` and display name of each tracked satellite. */
export function satelliteObjects(tracked: { key: string; name: string }[]): ObjectDef[] {
    const out: ObjectDef[] = [
        channel('satellites', 'Satellites'),
        json('satellites.tle', 'Orbit set from CelesTrak (JSON)', '{"sats":[]}'),
        text('satellites.alert', 'Satellite pass alert'),
    ];
    for (const { key, name } of tracked) {
        const id = `satellites.${key}`;
        out.push(
            channel(id, name),
            flag(`${id}.visibleNow`, `${name} visible now`),
            json(`${id}.passes`, `${name} visible passes, next 72 h (JSON)`, '{"passes":[]}'),
            channel(`${id}.next`, `${name} next visible pass`),
            time(`${id}.next.start`, 'Comes into view', 'date.start'),
            time(`${id}.next.end`, 'Goes out of view', 'date.end'),
            degrees(`${id}.next.maxEl`, 'Highest elevation', 0, 90),
            time(`${id}.next.maxAt`, 'Highest at'),
            degrees(`${id}.next.fromAz`, 'Comes into view at azimuth', 0, 360),
            degrees(`${id}.next.toAz`, 'Goes out of view at azimuth', 0, 360),
            text(`${id}.next.text`, 'Description'),
        );
    }
    return out;
}

export function astronomyObjects(): ObjectDef[] {
    const out: ObjectDef[] = [
        channel('astronomy', 'Astronomy'),
        state('astronomy.darkness', {
            name: 'Darkness',
            type: 'string',
            role: 'text',
            def: 'day',
            states: { ...DARKNESS_LABELS },
        }),
        json('astronomy.tonight', "Tonight's sky (JSON)", '{}'),
        text('astronomy.tonightText', "Tonight's sky"),
        channel('astronomy.moon', 'Moon'),
        text('astronomy.moon.phase', 'Phase'),
        state('astronomy.moon.illumination', {
            name: 'Illuminated',
            type: 'number',
            role: 'value',
            unit: '%',
            min: 0,
            max: 100,
        }),
        degrees('astronomy.moon.elevation', 'Elevation', -90, 90),
        time('astronomy.moon.rise', 'Next moonrise'),
        time('astronomy.moon.set', 'Next moonset'),
        channel('astronomy.planets', 'Planets'),
    ];
    for (const key of Object.keys(PLANETS)) {
        const id = `astronomy.planets.${key}`;
        const name = key.charAt(0).toUpperCase() + key.slice(1);
        out.push(
            channel(id, name),
            flag(`${id}.visible`, `${name} visible now`),
            degrees(`${id}.elevation`, 'Elevation', -90, 90),
            degrees(`${id}.azimuth`, 'Azimuth', 0, 360),
            time(`${id}.rise`, 'Next rise'),
            time(`${id}.set`, 'Next set'),
            state(`${id}.magnitude`, { name: 'Magnitude', type: 'number', role: 'value' }),
        );
    }
    return out;
}

export function auroraObjects(): ObjectDef[] {
    return [
        channel('aurora', 'Aurora'),
        flag('aurora.possible', 'Aurora possible from home now'),
        text('aurora.reason', 'Why (or why not)'),
        text('aurora.summary', 'Aurora chance from home'),
        json('aurora.inputs', 'Aurora inputs (JSON)', '{}'),
        text('aurora.alert', 'Aurora alert'),
    ];
}

export function lightningObjects(): ObjectDef[] {
    return [
        channel('lightning', 'Lightning'),
        state('lightning.nearestKm', {
            name: 'Nearest strike in the last hour',
            type: 'number',
            role: 'value.distance',
            unit: 'km',
        }),
        state('lightning.count1h', {
            name: 'Strikes within the radius in the last hour',
            type: 'number',
            role: 'value',
        }),
        time('lightning.lastNearAt', 'Latest strike within the near radius'),
        json('lightning.strikes', 'Strikes within the radius in the last hour (JSON)', '{"strikes":[]}'),
        text('lightning.alert', 'Lightning alert'),
    ];
}

/** Meteor showers, eclipses, moon and planet events, and (optional) the stargazing forecast. */
export function skyExtrasObjects(forecast: boolean): ObjectDef[] {
    return [
        json('astronomy.meteors', 'Meteor showers (JSON)', '{}'),
        text('astronomy.meteorsText', 'Meteor showers'),
        json('astronomy.eclipses', 'Next eclipses seen from here (JSON)', '{}'),
        text('astronomy.eclipsesText', 'Next eclipses seen from here'),
        json('astronomy.events', 'Moon and planet events, next 30 days (JSON)', '[]'),
        text('astronomy.eventsText', 'Next moon and planet events'),
        ...(forecast
            ? [
                  json('astronomy.forecast', 'Cloud forecast (JSON)', '{}'),
                  text('astronomy.forecastText', 'Stargazing forecast for tonight'),
              ]
            : []),
    ];
}
