// What a module gets from the adapter.

import type * as utils from '@iobroker/adapter-core';
import type { NotifyEvent } from './notify';
import type { Location } from './util';

export interface Host {
    adapter: utils.AdapterInstance;
    log: ioBroker.Logger;
    home: Location;
    /** true once the instance is stopping: no more writes, no new work */
    stopped(): boolean;
    /** Write an own state (ack). Unchanged values are skipped unless `always`. */
    write(id: string, val: ioBroker.StateValue, always?: boolean): Promise<void>;
    /** Re-evaluate info.connection from the sources' health. */
    updateConnection(): Promise<void>;
    /** Send an alert to the configured messaging adapters / ioBroker notifications (quiet hours, cooldown apply). */
    notify(event: NotifyEvent, message: string): Promise<void>;
}
