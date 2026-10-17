// Notifications: alerts sent to messaging adapters (each wants its own command/payload) and, optionally, to
// ioBroker's own notification system (Admin, notification-manager). Every alert is also a state, so users can build
// their own rules instead.

export const EVENTS = ['satellitePass', 'aurora', 'lightning', 'aircraftEmergency'] as const;
export type NotifyEvent = (typeof EVENTS)[number];

export const EVENT_TITLES: Record<NotifyEvent, string> = {
    satellitePass: 'Satellite pass',
    aurora: 'Aurora',
    lightning: 'Lightning',
    aircraftEmergency: 'Aircraft emergency',
};

export interface Target {
    instance: string;
    recipient: string;
    events: NotifyEvent[];
}

export interface EventRule {
    /** at most one message per event in this time (0: no limit) */
    cooldownMs: number;
    /** quiet from this hour until that hour, host time; equal: never quiet */
    quietFrom: number;
    quietTo: number;
}

/** The hour is within the quiet time (which may wrap past midnight). */
export function inQuietHours(hour: number, from: number, to: number): boolean {
    if (from === to) {
        return false;
    }
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

export const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]*\.\d{1,3}$/;

/**
 * The sendTo command and payload for one messaging adapter, from each adapter's message handler. null: this target
 * cannot be reached as configured (Discord needs a recipient).
 */
export function payloadFor(
    instance: string,
    title: string,
    message: string,
    recipient: string,
): { command: string; payload: unknown } | null {
    const adapter = instance.split('.')[0];
    const line = `${title}: ${message}`;
    switch (adapter) {
        case 'pushover':
        case 'pushsafer':
        case 'pushbullet':
        case 'gotify':
            return { command: 'send', payload: { title, message } };
        case 'ntfy-client':
            return { command: 'send', payload: { title, message, ...(recipient ? { topic: recipient } : {}) } };
        case 'telegram':
            return { command: 'send', payload: { text: line, ...(recipient ? { user: recipient } : {}) } };
        case 'signal-cmb':
        case 'whatsapp-cmb':
        case 'matrix-org':
            return { command: 'send', payload: { text: line } };
        case 'email':
            return {
                command: 'send',
                payload: { subject: title, text: message, ...(recipient ? { to: recipient } : {}) },
            };
        case 'discord': {
            const content = `**${title}**: ${message}`;
            const channel = /^(\d{5,25})\/(\d{5,25})$/.exec(recipient);
            if (channel) {
                return { command: 'send', payload: { content, serverId: channel[1], channelId: channel[2] } };
            }
            if (/^\d{5,25}$/.test(recipient)) {
                return { command: 'send', payload: { content, userId: recipient } };
            }
            return recipient ? { command: 'send', payload: { content, userName: recipient } } : null;
        }
        case 'synochat':
            // posted through its message template; a plain string arrives readable
            return { command: 'send', payload: line };
        default:
            return { command: 'send', payload: { title, subject: title, message, text: line } };
    }
}

export interface NotifierDeps {
    sendTo(instance: string, command: string, payload: unknown): void;
    registerNotification(category: NotifyEvent, message: string): Promise<void>;
    log: { warn(msg: string): void; debug(msg: string): void };
}

/** Sends alerts, honouring each event's quiet hours and cooldown. */
export class Notifier {
    private readonly lastSent = new Map<NotifyEvent, number>();
    private readonly warned = new Set<string>();

    public constructor(
        private readonly targets: Target[],
        private readonly rules: Record<NotifyEvent, EventRule>,
        private readonly admin: boolean,
        private readonly deps: NotifierDeps,
    ) {}

    /** One test message to every target, whatever its events, cooldown or quiet hours. Returns how many were sent. */
    public test(): number {
        let sent = 0;
        for (const t of this.targets) {
            const p = payloadFor(t.instance, 'Skyorama: Test', 'Test notification from Skyorama', t.recipient);
            if (p) {
                this.deps.sendTo(t.instance, p.command, p.payload);
                sent++;
            }
        }
        return sent;
    }

    public async notify(event: NotifyEvent, message: string, now = new Date()): Promise<void> {
        const targets = this.targets.filter(t => t.events.includes(event));
        if (!message || (!targets.length && !this.admin)) {
            return;
        }
        const rule = this.rules[event];
        if (inQuietHours(now.getHours(), rule.quietFrom, rule.quietTo)) {
            this.deps.log.debug(`Notification skipped (quiet hours): ${message}`);
            return;
        }
        const last = this.lastSent.get(event);
        if (last !== undefined && now.getTime() - last < rule.cooldownMs) {
            this.deps.log.debug(`Notification skipped (cooldown): ${message}`);
            return;
        }
        this.lastSent.set(event, now.getTime());
        const title = `Skyorama: ${EVENT_TITLES[event]}`;
        for (const t of targets) {
            const p = payloadFor(t.instance, title, message, t.recipient);
            if (!p) {
                if (!this.warned.has(t.instance)) {
                    this.warned.add(t.instance);
                    this.deps.log.warn(
                        `Notifications to ${t.instance} need a recipient (Discord user ID, user name or server/channel ID)`,
                    );
                }
                continue;
            }
            this.deps.sendTo(t.instance, p.command, p.payload);
        }
        if (this.admin) {
            try {
                await this.deps.registerNotification(event, `${EVENT_TITLES[event]}: ${message}`);
            } catch (err) {
                this.deps.log.debug(
                    `ioBroker notification failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }
}

/** The settings table → valid targets (enabled, a plausible instance id, at least one event). */
export function targetsFrom(rows: unknown): Target[] {
    if (!Array.isArray(rows)) {
        return [];
    }
    const out: Target[] = [];
    for (const r of rows as Record<string, unknown>[]) {
        const instance = typeof r?.instance === 'string' ? r.instance.trim() : '';
        if (!r || r.enabled === false || !INSTANCE_RE.test(instance)) {
            continue;
        }
        const events = EVENTS.filter(e => r[e] === true);
        if (events.length) {
            out.push({ instance, recipient: typeof r.recipient === 'string' ? r.recipient.trim() : '', events });
        }
    }
    return out;
}
