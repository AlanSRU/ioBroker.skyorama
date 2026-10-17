/*
 * Skyorama: what's in the sky over your location.
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { AstronomyModule } from './lib/astronomy';
import type { Host } from './lib/host';
import { astronomyObjects, infoObjects, satelliteObjects, type ObjectDef } from './lib/objects';
import { SatellitesModule, groupList } from './lib/satellites';
import { clamp, toLocation, type Location } from './lib/util';

class Skyorama extends utils.Adapter {
    private unloaded = false;
    private satellites: SatellitesModule | undefined;
    private astronomy: AstronomyModule | undefined;

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
        // Disabled modules keep their objects (and the user's history/alias settings on them).
        await this.ensureObjects([
            ...infoObjects(sats),
            ...(sats ? satelliteObjects() : []),
            ...(astro ? astronomyObjects() : []),
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

    /** info.connection: every enabled data source reachable (no sources: true). */
    private async updateConnection(): Promise<void> {
        const celestrak = this.satellites?.health;
        if (celestrak) {
            await this.write('info.celestrak', celestrak.reachable);
        }
        await this.write('info.connection', celestrak ? celestrak.reachable : true);
    }

    private onMessage(obj: ioBroker.Message): void {
        if (!obj?.callback) {
            return;
        }
        let reply: unknown;
        switch (obj.command) {
            case 'tle':
                reply = this.satellites ? this.satellites.orbits : { error: 'Satellites module is off' };
                break;
            default:
                reply = { error: `Unknown command "${obj.command}"` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    private onUnload(callback: () => void): void {
        this.unloaded = true;
        try {
            this.satellites?.stop();
            this.astronomy?.stop();
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
