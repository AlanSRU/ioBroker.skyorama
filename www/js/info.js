/*
 * The information box for an aircraft or satellite, shared by the dome and the map. For an aircraft it shows what
 * the position data says, then the airline, photo and (if a route lookup is configured) the route from the adapter's
 * `lookup`, and keeps the position fresh with `follow` every 3 s while open.
 */
(function () {
    'use strict';

    const P = window.SkyoramaPage;
    const SQUAWK = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };
    const FOLLOW_MS = 3000;

    class SkyoramaInfo {
        /**
         * `onFollow(hex, plane, at)`: a fresher position for the open aircraft (`at`: when the adapter got it), so the
         * page can move its marker. `onClose()`: the box was closed.
         */
        constructor(onFollow, onClose) {
            this.onFollow = onFollow || (() => undefined);
            this.onClose = onClose || (() => undefined);
            this.el = document.createElement('aside');
            this.el.className = 'sky-info';
            this.el.hidden = true;
            this.el.setAttribute('aria-live', 'polite');
            document.body.appendChild(this.el);
            this.el.addEventListener('click', e => {
                if (e.target.closest('[data-close]')) {
                    this.close();
                }
            });
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape' && !this.el.hidden) {
                    this.close();
                }
            });
            this.lookups = new Map(); // "hex|callsign" → answer of `lookup`
            this.pending = new Set();
            this.failedAt = new Map(); // "hex|callsign" → when the lookup failed (asked again after 30 s)
            this.plane = null;
            this.fix = null; // the last follow answer for the open aircraft: { hex, fields, receivedAt }
            this.sat = null;
            this.followTimer = null;
        }

        get openHex() {
            return this.plane ? this.plane.hex : null;
        }

        static key(a) {
            return `${a.hex}|${a.flight || ''}`;
        }

        showAircraft(a) {
            this.sat = null;
            const changed = !this.plane || this.plane.hex !== a.hex;
            if (changed) {
                this.fix = null;
            }
            this.plane = this.withFix(Object.assign({}, a));
            this.render();
            void this.lookup(this.plane);
            if (changed) {
                this.startFollow();
            }
        }

        /** The follow answer's position over the area data, while it is the fresher of the two. */
        withFix(a) {
            const f = this.fix;
            if (f && f.hex === a.hex && Date.now() - f.receivedAt < FOLLOW_MS * 2) {
                Object.assign(a, f.fields);
            }
            return a;
        }

        /** New area data: everything from it (distance, status, type …), the position from a fresher follow answer. */
        update(list) {
            if (!this.plane) {
                return;
            }
            const a = list.find(x => x.hex === this.plane.hex);
            if (!a) {
                return;
            }
            this.plane = this.withFix(Object.assign({}, a));
            this.render();
            void this.lookup(this.plane); // a callsign may have appeared or changed
        }

        showSatellite(s) {
            this.stopFollow();
            this.plane = null;
            this.fix = null;
            this.sat = s;
            this.render();
        }

        close() {
            const wasOpen = !this.el.hidden;
            this.stopFollow();
            this.plane = null;
            this.fix = null;
            this.sat = null;
            this.el.hidden = true;
            this.el.innerHTML = '';
            if (wasOpen) {
                this.onClose();
            }
        }

        /** Airline, route and photo, once per aircraft and callsign (the route belongs to the flight). */
        async lookup(a) {
            const key = SkyoramaInfo.key(a);
            const failed = this.failedAt.get(key);
            if (this.lookups.has(key) || this.pending.has(key) || (failed && Date.now() - failed < 30_000)) {
                return;
            }
            this.pending.add(key);
            // the first lookup can be slow (airline list, photo by address then by registration)
            const answer = await P.sendTo(
                'lookup',
                { hex: a.hex, flight: a.flight || '', reg: a.reg || null, lat: a.lat, lon: a.lon },
                60_000,
            );
            this.pending.delete(key);
            if (answer.error) {
                this.failedAt.set(key, Date.now());
            } else {
                this.lookups.set(key, answer);
                this.failedAt.delete(key);
            }
            if (this.plane && SkyoramaInfo.key(this.plane) === key) {
                this.render();
            }
        }

        startFollow() {
            this.stopFollow();
            const tick = async () => {
                const hex = this.openHex;
                if (!hex || document.hidden) {
                    return;
                }
                const f = await P.sendTo('follow', { hex });
                if (this.openHex !== hex || f.error || !f.found || !f.ac) {
                    return;
                }
                const ac = f.ac;
                const fields = { lat: ac.lat, lon: ac.lon };
                for (const [k, v] of [
                    ['alt', ac.altBaro],
                    ['gs', ac.gs],
                    ['track', ac.track],
                    ['vr', ac.vr],
                ]) {
                    if (v != null) {
                        fields[k] = v;
                    }
                }
                this.fix = { hex, fields, receivedAt: Date.now() };
                this.plane = this.withFix(this.plane);
                this.onFollow(hex, this.plane, f.at);
                this.render();
            };
            this.followTimer = setInterval(() => void tick(), FOLLOW_MS);
        }

        stopFollow() {
            if (this.followTimer) {
                clearInterval(this.followTimer);
                this.followTimer = null;
            }
        }

        render() {
            if (this.plane) {
                this.el.innerHTML = this.aircraftHtml(this.plane);
            } else if (this.sat) {
                this.el.innerHTML = this.satelliteHtml(this.sat);
            } else {
                return;
            }
            this.el.hidden = false;
        }

        aircraftHtml(p) {
            const e = P.esc;
            const key = SkyoramaInfo.key(p);
            const info = this.lookups.get(key);
            const failed = !info && this.failedAt.has(key) && !this.pending.has(key);
            const name = p.flight || p.reg || String(p.hex).toUpperCase();
            const row = (k, v) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`;
            const looking = 'looking up…';
            let route = '';
            if (info && info.route) {
                const r = info.route;
                const q = r.plausible ? '' : ' (?)';
                route = row('From', `${r.from} · ${r.fromName}${q}`) + row('To', `${r.to} · ${r.toName}${q}`);
            }
            const squawk = p.squawk ? `${p.squawk}${SQUAWK[p.squawk] ? ` · ${SQUAWK[p.squawk]}` : ''}` : '–';
            const photo =
                info && info.photo && /^https:\/\//.test(info.photo.src) && /^https:\/\//.test(info.photo.link)
                    ? `<a class="photo" href="${e(info.photo.link)}" target="_blank" rel="noopener noreferrer"><img src="${e(
                          info.photo.src,
                      )}" alt="${e(p.reg || name)}"></a><span class="credit">Photo © ${e(info.photo.by)} / planespotters.net</span>`
                    : '';
            return `<div class="head"><h2>${e(name)}</h2><button type="button" data-close aria-label="Close">✕</button></div>
                ${photo}
                ${p.emergency ? `<div class="alert">${e(p.emergency)}${p.squawk ? ` · squawk ${e(p.squawk)}` : ''}</div>` : ''}
                <dl>
                ${row('Airline', info ? info.airline || '–' : failed ? 'not available' : looking)}
                ${route}
                ${row('Type', p.type || '–')}
                ${row('Registration', p.reg || '–')}
                ${row('Altitude', P.fmt.alt(p.alt) + (p.alt >= 6000 ? ` · ${Math.round(p.alt).toLocaleString()} ft` : ''))}
                ${row('Selected altitude', p.selAlt != null ? P.fmt.alt(p.selAlt) : '–')}
                ${row('Climb', p.vr != null && p.alt > 0 ? `${p.vr > 0 ? '+' : ''}${Math.round(p.vr).toLocaleString()} ft/min` : '–')}
                ${row('Speed', p.gs != null ? `${Math.round(p.gs)} kt` : '–')}
                ${row('Track', P.fmt.deg(p.track))}
                ${row('Distance', `${P.fmt.dist(p.dst)}${p.dir != null ? ` · bearing ${P.fmt.deg(p.dir)}` : ''}`)}
                ${row('Squawk', squawk)}
                ${row('Status', p.alt != null && p.alt <= 0 ? 'On the ground' : p.stale ? 'Airborne · signal lost' : 'Airborne')}
                ${row('ICAO address', String(p.hex).toUpperCase())}
                </dl>`;
        }

        satelliteHtml(s) {
            const e = P.esc;
            const row = (k, v) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`;
            const n = s.nextPass;
            return `<div class="head"><h2>${e(s.name)}</h2><button type="button" data-close aria-label="Close">✕</button></div>
                <dl>
                ${row('Now', s.visible ? 'Visible' : s.lit ? 'Lit, but the sky is too bright or it is too low' : 'In the earth’s shadow')}
                ${row('Elevation', `${Math.round(s.el)}°`)}
                ${row('Azimuth', P.fmt.deg(s.az))}
                ${n ? row('Next visible pass', `${P.fmt.time(n.start)}, highest ${Math.round(n.maxEl)}°`) : ''}
                ${row('Catalogue number', s.id)}
                </dl>`;
        }
    }

    window.SkyoramaInfo = SkyoramaInfo;
})();
