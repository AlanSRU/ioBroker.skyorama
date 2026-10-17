const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

const NS = 'skyorama.0';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        // Astronomy only: no network access from CI.
        suite('Astronomy at a manual location', getHarness => {
            let harness;
            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const waitFor = async (id, timeoutMs = 15000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && state.val !== null) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };
            const sendTo = (command, message) =>
                new Promise(resolve => harness.sendTo(NS, command, message, resolve));

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                await harness.changeAdapterConfig('skyorama', {
                    native: {
                        useSystemLocation: false,
                        latitude: 55.95,
                        longitude: -3.19,
                        satellitesEnabled: false,
                        astronomyEnabled: true,
                        aircraftEnabled: true,
                        backgroundEnabled: false,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            it('writes the sky facts and tonight', async function () {
                this.timeout(30000);
                expect(await waitFor('astronomy.darkness')).to.be.oneOf([
                    'day',
                    'civil',
                    'nautical',
                    'astronomical',
                    'night',
                ]);
                expect(await waitFor('astronomy.moon.illumination')).to.be.within(0, 100);
                expect(await waitFor('astronomy.planets.jupiter.elevation')).to.be.within(-90, 90);
                expect(await waitFor('astronomy.tonightText')).to.be.a('string').that.is.not.empty;
                expect(await waitFor('info.connection')).to.equal(true);
            });

            it('answers sendTo, also with errors', async function () {
                this.timeout(10000);
                expect(await sendTo('tle', {})).to.deep.equal({ error: 'Satellites module is off' });
                expect(await sendTo('nonsense', {})).to.have.property('error');
                // aircraft: invalid input is answered without touching the network
                expect(await sendTo('follow', { hex: 'not-a-hex' })).to.deep.equal({
                    error: 'hex must be a 6-digit ICAO address',
                });
                expect(await sendTo('lookup', JSON.stringify({ hex: '' }))).to.have.property('error');
            });
        });
    },
});
