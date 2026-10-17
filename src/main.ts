/*
 * Skyorama: what's in the sky over your location.
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { AircraftModule, MAX_RADIUS_NM, hexOf } from './lib/aircraft';
import { connect } from 'mqtt';
import { AstronomyModule } from './lib/astronomy';
import { AuroraModule } from './lib/aurora';
import type { SourceHealth } from './lib/health';
import type { Host } from './lib/host';
import { LightningModule, topicPrefixOf } from './lib/lightning';
import { EVENTS, Notifier, targetsFrom, type EventRule, type NotifyEvent } from './lib/notify';
import {
    aircraftObjects,
    astronomyObjects,
    auroraObjects,
    infoObjects,
    lightningObjects,
    satelliteObjects,
    type ObjectDef,
} from './lib/objects';
import {
    SatellitesModule,
    catalogueNumber,
    groupList,
    keyOf,
    nameOf,
    satelliteOptions,
    trackedIds,
    type Tle,
} from './lib/satellites';
import { NM, clamp, num, toLocation, urlSettingOf, type Location } from './lib/util';

class Skyorama extends utils.Adapter {
    private unloaded = false;
    private satellites: SatellitesModule | undefined;
    private astronomy: AstronomyModule | undefined;
    private aircraft: AircraftModule | undefined;
    private aurora: AuroraModule | undefined;
    private lightning: LightningModule | undefined;
    private notifier: Notifier | undefined;

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
        const tracked = trackedIds(this.config.trackedSatellites);
        if (sats && tracked.capped) {
            this.log.warn(
                `More than ${tracked.ids.length} satellites selected: only the first ${tracked.ids.length} are tracked`,
            );
        }
        // names from the saved orbit set, so the objects show them from the start
        let savedTle: Tle[] = [];
        try {
            const j = JSON.parse(String((await this.getStateAsync('satellites.tle'))?.val || '{}')) as { sats?: Tle[] };
            savedTle = Array.isArray(j.sats) ? j.sats : [];
        } catch {
            savedTle = [];
        }
        const trackedObjects = tracked.ids.map(id => ({
            key: keyOf(id),
            name: nameOf(
                id,
                savedTle.find(t => catalogueNumber(t[1]) === id),
            ),
        }));
        const astro = !!this.config.astronomyEnabled;
        const planes = !!this.config.aircraftEnabled;
        // every external feed is the user's own choice: nothing is used unless configured
        const areaUrl = planes ? this.urlSetting('Aircraft area source URL', this.config.aircraftAreaUrl) : '';
        const lookupUrls = planes
            ? [
                  this.urlSetting('Aircraft lookup URL', this.config.aircraftLookupUrl),
                  this.urlSetting('Aircraft lookup fallback URL', this.config.aircraftLookupUrl2),
              ].filter(Boolean)
            : [];
        const routeUrl = planes ? this.urlSetting('Route lookup URL', this.config.aircraftRouteUrl) : '';
        if (planes && !areaUrl) {
            this.log.warn('Aircraft is on but no aircraft area source is configured');
        }
        const header = planes ? this.headerSetting() : null;
        const background = planes && !!this.config.backgroundEnabled;
        const aurora = !!this.config.auroraEnabled;
        const auroraWatch = aurora && !!this.config.auroraWatchUk;
        const brokerUrl = this.config.lightningEnabled
            ? this.urlSetting('Lightning broker URL', this.config.lightningBrokerUrl, [
                  'mqtt:',
                  'mqtts:',
                  'ws:',
                  'wss:',
              ])
            : '';
        const topicPrefix = topicPrefixOf(this.config.lightningTopicPrefix);
        if (this.config.lightningEnabled && (!brokerUrl || !topicPrefix)) {
            this.log.warn('Lightning is on but no valid feed (broker URL and topic prefix) is configured');
        }
        const lightning = !!this.config.lightningEnabled && !!brokerUrl && !!topicPrefix;
        const sources = [
            ...(sats ? [{ id: 'celestrak', name: 'CelesTrak' }] : []),
            ...(areaUrl ? [{ id: 'aircraftArea', name: 'Aircraft area source' }] : []),
            ...(lookupUrls.length ? [{ id: 'aircraftLookup', name: 'Aircraft lookup source' }] : []),
            ...(lookupUrls.length > 1 ? [{ id: 'aircraftLookup2', name: 'Aircraft lookup fallback' }] : []),
            ...(aurora
                ? [
                      { id: 'noaa', name: 'NOAA SWPC' },
                      { id: 'openmeteo', name: 'Open-Meteo' },
                  ]
                : []),
            ...(auroraWatch ? [{ id: 'aurorawatch', name: 'AuroraWatch UK' }] : []),
            ...(lightning ? [{ id: 'lightning', name: 'Lightning feed' }] : []),
        ];
        // Disabled modules keep their objects (and the user's history/alias settings on them).
        await this.ensureObjects([
            ...infoObjects(sources),
            ...(sats ? satelliteObjects(trackedObjects) : []),
            ...(astro ? astronomyObjects() : []),
            ...(background ? aircraftObjects() : []),
            ...(aurora ? auroraObjects() : []),
            ...(lightning ? lightningObjects() : []),
        ]);
        if (this.unloaded) {
            return;
        }
        if (sats) {
            await this.removeUntracked(trackedObjects.map(t => t.key));
        }

        const host: Host = {
            adapter: this,
            log: this.log,
            home,
            stopped: () => this.unloaded,
            write: (id, val, always) => this.write(id, val, always),
            updateConnection: () => this.updateConnection(),
            notify: (event, message) => this.notifier?.notify(event, message) ?? Promise.resolve(),
        };
        this.notifier = this.createNotifier();
        if (sats) {
            this.satellites = new SatellitesModule(
                host,
                {
                    groups: groupList(this.config.satelliteGroups),
                    leadMin: clamp(this.config.passAlertLeadMin, 1, 120, 10),
                    minEl: clamp(this.config.passAlertMinEl, 0, 90, 20),
                    tracked: tracked.ids,
                },
                () => void this.astronomy?.refreshTonight(),
            );
        }
        if (astro) {
            this.astronomy = new AstronomyModule(host, () => this.satellites?.visiblePasses ?? []);
        }
        if (planes) {
            this.aircraft = new AircraftModule(host, {
                areaUrl,
                lookupUrls,
                routeUrl,
                header,
                background: {
                    enabled: background,
                    radiusNm: (clamp(this.config.backgroundRadiusKm, 1, (MAX_RADIUS_NM * NM) / 1000, 30) * 1000) / NM,
                    intervalMs: clamp(this.config.backgroundIntervalS, 30, 600, 60) * 1000,
                },
                overheadEl: clamp(this.config.overheadElevation, 10, 90, 45),
            });
            await this.aircraft.start();
            if (this.unloaded) {
                return;
            }
        }
        if (aurora) {
            const instance = String(this.config.auroraNowcastInstance ?? '').trim();
            this.aurora = new AuroraModule(host, {
                cloudLimit: clamp(this.config.auroraCloudLimit, 0, 100, 60),
                auroraWatch,
                nowcastInstance: /^aurora-nowcast\.\d{1,3}$/.test(instance) ? instance : '',
            });
        }
        if (lightning) {
            const radiusKm = clamp(this.config.lightningRadiusKm, 10, 1000, 300);
            this.lightning = new LightningModule(
                host,
                {
                    radiusKm,
                    nearKm: clamp(this.config.lightningNearKm, 1, radiusKm, 40),
                    brokerUrl,
                    topicPrefix,
                    username: String(this.config.lightningUsername ?? '').trim(),
                    password: String(this.config.lightningPassword ?? ''),
                },
                connect,
            );
        }
        await this.updateConnection();
        await this.satellites?.start();
        if (this.unloaded) {
            return;
        }
        await this.astronomy?.start();
        if (this.unloaded) {
            return;
        }
        await this.aurora?.start();
        if (this.unloaded) {
            return;
        }
        await this.lightning?.start();
    }

    /** A source URL from the settings, or '' with a warning saying why (the URL itself is not logged). */
    private urlSetting(label: string, value: unknown, schemes?: string[]): string {
        const r = urlSettingOf(value, schemes);
        if (r.problem) {
            this.log.warn(`${label} ${r.problem}: not used`);
        }
        return r.url;
    }

    /** The optional aircraft request header: a token name and a value without line breaks, or null. */
    private headerSetting(): { name: string; value: string } | null {
        const name = String(this.config.aircraftHeaderName ?? '').trim();
        const value = String(this.config.aircraftHeaderValue ?? '').trim();
        if (!name && !value) {
            return null;
        }
        if (
            !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) ||
            !value ||
            [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
        ) {
            this.log.warn('Aircraft request header is incomplete or invalid: not used');
            return null;
        }
        return { name, value };
    }

    /** A satellite removed from the selection takes its objects with it (its passes mean nothing any more). */
    private async removeUntracked(keys: string[]): Promise<void> {
        const view = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.satellites.`,
            endkey: `${this.namespace}.satellites.\u9999`,
        });
        for (const row of view.rows) {
            const rel = row.id.slice(this.namespace.length + 1);
            const m = /^satellites\.(iss|tiangong|n\d{1,9})$/.exec(rel);
            if (m && !keys.includes(m[1]) && !this.unloaded) {
                this.log.info(`Satellite ${m[1]} is no longer tracked: removing its states`);
                await this.delObjectAsync(rel, { recursive: true });
            }
        }
    }

    /** Notification targets and per-event rules from the settings (clamped here, not only in the UI). */
    private createNotifier(): Notifier {
        const cfg = this.config as unknown as Record<string, unknown>;
        const cap = (e: NotifyEvent): string => e.charAt(0).toUpperCase() + e.slice(1);
        const rules = Object.fromEntries(
            EVENTS.map(e => [
                e,
                {
                    cooldownMs: clamp(cfg[`notify${cap(e)}Cooldown`], 0, 1440, 0) * 60_000,
                    quietFrom: Math.round(clamp(cfg[`notify${cap(e)}QuietFrom`], 0, 23, 0)),
                    quietTo: Math.round(clamp(cfg[`notify${cap(e)}QuietTo`], 0, 23, 0)),
                },
            ]),
        ) as Record<NotifyEvent, EventRule>;
        const targets = targetsFrom(this.config.notifyTargets);
        const registerNotification = this.registerNotification.bind(this) as unknown as (
            scope: string,
            category: string,
            message: string,
        ) => Promise<void>;
        return new Notifier(targets, rules, !!this.config.notifyAdmin, {
            sendTo: (instance, command, payload) => {
                if (!this.unloaded) {
                    // fire and forget: every messaging adapter only answers when a callback is given
                    this.sendTo(instance, command, payload as ioBroker.MessagePayload);
                }
            },
            registerNotification: (category, message) =>
                this.unloaded ? Promise.resolve() : registerNotification('skyorama', category, message),
            log: this.log,
        });
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
            ...(this.aurora?.sources ?? []),
            ...(this.lightning ? [this.lightning.health] : []),
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
            case 'testNotification': {
                // the Notifications tab's test button (saved settings)
                if (!this.notifier) {
                    return { error: 'Notifications are not running (see the log)' };
                }
                const n = this.notifier.test();
                return n
                    ? { result: `Test notification sent to ${n} instance${n === 1 ? '' : 's'}` }
                    : { error: 'No usable notification target is saved' };
            }
            case 'satelliteOptions':
                // the settings' choice of satellites (selectSendTo): what the current orbit set contains
                return satelliteOptions(
                    this.satellites?.orbits.sats ?? [],
                    trackedIds(this.config.trackedSatellites).ids,
                );
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
            this.aurora?.stop();
            this.lightning?.stop();
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
