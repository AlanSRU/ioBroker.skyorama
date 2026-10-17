/*
 * Skyorama: what's in the sky over your location.
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { AircraftModule, MAX_RADIUS_NM, hexOf } from './lib/aircraft';
import { AstronomyModule } from './lib/astronomy';
import type { SourceHealth } from './lib/health';
import type { Host } from './lib/host';
import { aircraftObjects, astronomyObjects, infoObjects, satelliteObjects, type ObjectDef } from './lib/objects';
import { SatellitesModule, groupList } from './lib/satellites';
import { NM, clamp, num, receiverUrlOf, toLocation, type Location } from './lib/util';

class Skyorama extends utils.Adapter {
    private unloaded = false;
    private satellites: SatellitesModule | undefined;
    private astronomy: AstronomyModule | undefined;
    private aircraft: AircraftModule | undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'skyorama',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        const home = await this.resolveHome();
        if (!home) {
            this.log.error(
                this.config.useSystemLocation
                    ? 'No location: set latitude and longitude in the ioBroker system settings, or enter them in the instance settings'
                    : 'No valid location in the instance settings',
            );
            return;
        }
        this.log.info(`Location ${home.lat.toFixed(3)}, ${home.lon.toFixed(3)}`);

        const sats = !!this.config.satellitesEnabled;
        const astro = !!this.config.astronomyEnabled;
        const planes = !!this.config.aircraftEnabled;
        const receiver = receiverUrlOf(this.config.receiverUrl);
        if (planes && receiver.problem) {
            // the URL itself is not logged: it may contain a password
            this.log.warn(`Local receiver URL ${receiver.problem}: using adsb.lol instead`);
        }
        const receiverUrl = receiver.url;
        const background = planes && !!this.config.backgroundEnabled;
        const sources = [
            ...(sats ? [{ id: 'celestrak', name: 'CelesTrak' }] : []),
            ...(planes
                ? [
                      { id: 'adsblol', name: 'adsb.lol' },
                      { id: 'adsbfi', name: 'adsb.fi' },
                  ]
                : []),
            ...(planes && receiverUrl ? [{ id: 'receiver', name: 'Local receiver' }] : []),
        ];
        // Disabled modules keep their objects (and the user's history/alias settings on them).
        await this.ensureObjects([
            ...infoObjects(sources),
            ...(sats ? satelliteObjects() : []),
            ...(astro ? astronomyObjects() : []),
            ...(background ? aircraftObjects() : []),
        ]);
        if (this.unloaded) {
            return;
        }

        const host: Host = {
            adapter: this,
            log: this.log,
            home,
            stopped: () => this.unloaded,
            write: (id, val, always) => this.write(id, val, always),
            updateConnection: () => this.updateConnection(),
        };
        if (sats) {
            this.satellites = new SatellitesModule(
                host,
                {
                    groups: groupList(this.config.satelliteGroups),
                    leadMin: clamp(this.config.passAlertLeadMin, 1, 120, 10),
                    minEl: clamp(this.config.passAlertMinEl, 0, 90, 20),
                },
                () => void this.astronomy?.refreshTonight(),
            );
        }
        if (astro) {
            this.astronomy = new AstronomyModule(host, () => this.satellites?.visiblePasses ?? []);
        }
        if (planes) {
            this.aircraft = new AircraftModule(host, {
                receiverUrl,
                background: {
                    enabled: background,
                    radiusNm: (clamp(this.config.backgroundRadiusKm, 1, (MAX_RADIUS_NM * NM) / 1000, 30) * 1000) / NM,
                    intervalMs: clamp(this.config.backgroundIntervalS, 30, 600, 60) * 1000,
                },
                overheadEl: clamp(this.config.overheadElevation, 10, 90, 45),
            });
            this.aircraft.start();
        }
        await this.updateConnection();
        await this.satellites?.start();
        if (this.unloaded) {
            return;
        }
        await this.astronomy?.start();
    }

    /** Home: system.config, or the manual location from the settings. */
    private async resolveHome(): Promise<Location | null> {
        if (!this.config.useSystemLocation) {
            return toLocation(this.config.latitude, this.config.longitude);
        }
        const sys = await this.getForeignObjectAsync('system.config');
        return toLocation(sys?.common.latitude, sys?.common.longitude);
    }

    /**
     * Create or update (extendObject: upgrades get changed metadata) the objects, one at a time.
     */
    private async ensureObjects(defs: ObjectDef[]): Promise<void> {
        for (const d of defs) {
            if (this.unloaded) {
                return;
            }
            await this.extendObject(d.id, d.obj);
        }
    }

    /**
     * The one place own states are written; nothing is written once the instance is stopping.
     */
    private async write(id: string, val: ioBroker.StateValue, always = false): Promise<void> {
        if (this.unloaded) {
            return;
        }
        if (always) {
            await this.setState(id, val, true);
        } else {
            await this.setStateChangedAsync(id, val, true);
        }
    }

    /**
     * info.connection: every data source in use is reachable. On-demand sources nobody has asked yet don't count
     * (no sources in use: true).
     */
    private async updateConnection(): Promise<void> {
        const all: SourceHealth[] = [
            ...(this.satellites ? [this.satellites.health] : []),
            ...(this.aircraft?.sources ?? []),
        ];
        let ok = true;
        for (const h of all) {
            if (h.used && h.id) {
                await this.write(`info.${h.id}`, h.reachable);
                ok &&= h.reachable;
            }
        }
        await this.write('info.connection', ok);
    }

    private onMessage(obj: ioBroker.Message): void {
        if (!obj?.callback) {
            return;
        }
        void this.answer(obj.command, obj.message)
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
            .then(reply => {
                if (!this.unloaded) {
                    this.sendTo(obj.from, obj.command, reply, obj.callback);
                }
            });
    }

    /** The sendTo API. Invalid input and switched-off modules answer `{ error }`. */
    private async answer(command: string, message: unknown): Promise<unknown> {
        let m: Record<string, unknown> = {};
        if (typeof message === 'string') {
            try {
                m = JSON.parse(message) as Record<string, unknown>;
            } catch {
                m = {};
            }
        } else if (message && typeof message === 'object') {
            m = message as Record<string, unknown>;
        }
        switch (command) {
            case 'tle':
                return this.satellites ? this.satellites.orbits : { error: 'Satellites module is off' };
            case 'aircraft':
                if (!this.aircraft) {
                    return { error: 'Aircraft module is off' };
                }
                return this.aircraft.aircraft(clamp(m.radiusNm, 1, MAX_RADIUS_NM, 40));
            case 'follow': {
                const hex = hexOf(m.hex);
                if (!this.aircraft) {
                    return { error: 'Aircraft module is off' };
                }
                return hex ? this.aircraft.follow(hex) : { error: 'hex must be a 6-digit ICAO address' };
            }
            case 'lookup': {
                const hex = hexOf(m.hex);
                if (!this.aircraft) {
                    return { error: 'Aircraft module is off' };
                }
                if (!hex) {
                    return { error: 'hex must be a 6-digit ICAO address' };
                }
                return this.aircraft.lookup({
                    hex,
                    flight: typeof m.flight === 'string' ? m.flight.trim().toUpperCase() : '',
                    reg: typeof m.reg === 'string' && m.reg.trim() ? m.reg.trim() : null,
                    lat: num(m.lat),
                    lon: num(m.lon),
                });
            }
            default:
                return { error: `Unknown command "${command}"` };
        }
    }

    private onUnload(callback: () => void): void {
        this.unloaded = true;
        try {
            this.satellites?.stop();
            this.astronomy?.stop();
            this.aircraft?.stop();
            void this.setState('info.connection', false, true);
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Skyorama(options);
} else {
    // otherwise start the instance directly
    (() => new Skyorama())();
}
