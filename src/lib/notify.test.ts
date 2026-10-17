import { expect } from 'chai';
import { EVENTS, Notifier, inQuietHours, payloadFor, targetsFrom, type EventRule, type NotifyEvent } from './notify';

describe('notify: quiet hours', () => {
    it('handles quiet times within a day and across midnight', () => {
        expect(inQuietHours(2, 1, 5)).to.equal(true);
        expect(inQuietHours(5, 1, 5)).to.equal(false);
        expect(inQuietHours(23, 22, 7)).to.equal(true);
        expect(inQuietHours(6, 22, 7)).to.equal(true);
        expect(inQuietHours(12, 22, 7)).to.equal(false);
        expect(inQuietHours(12, 0, 0)).to.equal(false); // same hour: never quiet
    });
});

describe('notify: payload per messaging adapter', () => {
    const t = 'Skyorama: Aurora';
    const m = 'Possible from home';

    it('uses message + title where the adapter reads those', () => {
        for (const a of ['pushover', 'pushsafer', 'pushbullet', 'gotify']) {
            expect(payloadFor(`${a}.0`, t, m, '')).to.deep.equal({
                command: 'send',
                payload: { title: t, message: m },
            });
        }
        expect(payloadFor('ntfy-client.0', t, m, 'sky')!.payload).to.deep.equal({ title: t, message: m, topic: 'sky' });
    });

    it('puts the title into the text where there is no title field', () => {
        for (const a of ['signal-cmb', 'whatsapp-cmb', 'matrix-org']) {
            expect(payloadFor(`${a}.0`, t, m, '')!.payload).to.deep.equal({ text: `${t}: ${m}` });
        }
        expect(payloadFor('telegram.0', t, m, '')!.payload).to.deep.equal({ text: `${t}: ${m}` });
        expect(payloadFor('telegram.0', t, m, 'alan')!.payload).to.deep.equal({ text: `${t}: ${m}`, user: 'alan' });
        expect(payloadFor('synochat.0', t, m, '')!.payload).to.equal(`${t}: ${m}`);
    });

    it('sends email with subject, and a recipient when given', () => {
        expect(payloadFor('email.0', t, m, 'a@b.c')!.payload).to.deep.equal({ subject: t, text: m, to: 'a@b.c' });
        expect(payloadFor('email.0', t, m, '')!.payload).to.deep.equal({ subject: t, text: m });
    });

    it('needs a recipient for Discord: user ID, user name or server/channel', () => {
        expect(payloadFor('discord.0', t, m, '')).to.equal(null);
        expect(payloadFor('discord.0', t, m, '123456789012345678')!.payload).to.include({
            userId: '123456789012345678',
        });
        expect(payloadFor('discord.0', t, m, 'alan.p')!.payload).to.include({ userName: 'alan.p' });
        expect(payloadFor('discord.0', t, m, '111111/222222')!.payload).to.include({
            serverId: '111111',
            channelId: '222222',
        });
    });

    it('falls back to a generic payload for other adapters', () => {
        expect(payloadFor('someother.1', t, m, '')).to.deep.equal({
            command: 'send',
            payload: { title: t, subject: t, message: m, text: `${t}: ${m}` },
        });
    });
});

describe('notify: settings table', () => {
    it('keeps enabled rows with a valid instance and at least one event', () => {
        const rows = [
            { enabled: true, instance: 'pushover.0', recipient: ' ', aurora: true, lightning: false },
            { enabled: false, instance: 'telegram.0', aurora: true },
            { enabled: true, instance: '', aurora: true },
            { enabled: true, instance: 'email.0' },
            { enabled: true, instance: 'bad instance', aurora: true },
        ];
        expect(targetsFrom(rows)).to.deep.equal([{ instance: 'pushover.0', recipient: '', events: ['aurora'] }]);
        expect(targetsFrom(undefined)).to.deep.equal([]);
    });
});

describe('notify: notifier', () => {
    const rules = (over: Partial<EventRule> = {}): Record<NotifyEvent, EventRule> =>
        Object.fromEntries(EVENTS.map(e => [e, { cooldownMs: 0, quietFrom: 0, quietTo: 0, ...over }])) as Record<
            NotifyEvent,
            EventRule
        >;

    function make(
        r: Record<NotifyEvent, EventRule>,
        admin = false,
        recipient = '',
    ): {
        n: Notifier;
        sent: [string, string, unknown][];
        admin: string[];
        warnings: string[];
    } {
        const sent: [string, string, unknown][] = [];
        const adminMsgs: string[] = [];
        const warnings: string[] = [];
        const n = new Notifier(
            [
                { instance: 'pushover.0', recipient: '', events: ['aurora', 'lightning'] },
                { instance: 'discord.0', recipient, events: ['aurora'] },
            ],
            r,
            admin,
            {
                sendTo: (i, c, p) => sent.push([i, c, p]),
                registerNotification: (cat, msg) => {
                    adminMsgs.push(`${cat}|${msg}`);
                    return Promise.resolve();
                },
                log: { warn: w => warnings.push(w), debug: () => undefined },
            },
        );
        return { n, sent, admin: adminMsgs, warnings };
    }

    it('sends to the targets of the event only, warning once about a Discord row without recipient', async () => {
        const h = make(rules());
        await h.n.notify('lightning', 'Lightning 12 km SW');
        await h.n.notify('aurora', 'Possible from home');
        await h.n.notify('aurora', 'Possible again');
        expect(h.sent.map(s => s[0])).to.deep.equal(['pushover.0', 'pushover.0', 'pushover.0']);
        expect(h.warnings).to.have.length(1);
    });

    it('honours the cooldown and quiet hours', async () => {
        const h = make(rules({ cooldownMs: 30 * 60_000 }));
        const t0 = new Date(2026, 9, 17, 21, 0);
        await h.n.notify('lightning', 'one', t0);
        await h.n.notify('lightning', 'two', new Date(t0.getTime() + 10 * 60_000));
        await h.n.notify('lightning', 'three', new Date(t0.getTime() + 31 * 60_000));
        expect(h.sent.map(s => (s[2] as { message: string }).message)).to.deep.equal(['one', 'three']);
        const q = make(rules({ quietFrom: 23, quietTo: 7 }));
        await q.n.notify('lightning', 'night', new Date(2026, 9, 18, 2, 0));
        expect(q.sent).to.deep.equal([]);
    });

    it('also registers an ioBroker notification when asked', async () => {
        const h = make(rules(), true, '123456789012345678');
        await h.n.notify('aurora', 'Possible from home');
        expect(h.admin).to.deep.equal(['aurora|Aurora: Possible from home']);
        expect(h.sent.map(s => s[0])).to.deep.equal(['pushover.0', 'discord.0']);
    });
});
