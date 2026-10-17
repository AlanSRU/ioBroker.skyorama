import { expect } from 'chai';
import { SourceHealth } from './health';

function setup(): { health: SourceHealth; logs: { warn: string[]; info: string[]; debug: string[] } } {
    const logs = { warn: [] as string[], info: [] as string[], debug: [] as string[] };
    const health = new SourceHealth('Test', {
        warn: m => logs.warn.push(m),
        info: m => logs.info.push(m),
        debug: m => logs.debug.push(m),
    });
    return { health, logs };
}

describe('source health', () => {
    it('flips to unreachable only after 2 failures in a row, warning once', () => {
        const { health, logs } = setup();
        health.fail(new Error('timeout'));
        expect(health.reachable).to.equal(true);
        health.fail(new Error('timeout'));
        health.fail(new Error('timeout'));
        expect(health.reachable).to.equal(false);
        expect(logs.warn).to.have.length(1);
        expect(logs.debug).to.have.length(2);
        health.ok();
        expect(health.reachable).to.equal(true);
        expect(logs.info).to.deep.equal(['Test: reachable again']);
    });

    it('is not reachable until a first success when unproven', () => {
        const { health, logs } = setup();
        health.unproven();
        expect(health.reachable).to.equal(false);
        health.ok();
        expect(health.reachable).to.equal(true);
        expect(logs.info).to.deep.equal([]);
    });
});
