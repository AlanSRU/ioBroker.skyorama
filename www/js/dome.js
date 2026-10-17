/*
 * Skyorama dome: the sky above home, with the zenith in the middle and the horizon at the edge (north at the top,
 * east on the right, as on a map).
 * Self-contained (no libraries), so it can later be wrapped as a VIS-2 widget:
 *
 *   const dome = new SkyoramaDome(canvas);
 *   dome.setSky(answerOfSendToSky);        // sun, moon, planets, satellites (every ~10 s)
 *   dome.setAircraft(answerOfSendToAircraft); // optional
 *   dome.draw();                           // as often as wanted; moving things are interpolated
 *
 * The sky's colour follows the sun at home. Stars, planets, constellation figures and deep-sky objects are drawn only
 * when they could actually be seen: above the horizon and brighter than what the sky allows right now (twilight,
 * moonlight and the extra air near the horizon all hide the fainter ones).
 */
(function (global) {
    'use strict';

    const RAD = Math.PI / 180;
    const FT = 0.3048;
    const EARTH_R = 6371e3;

    // --- sky colours: [sun elevation, zenith, horizon] ---------------------------------------------------------------
    const SKY = [
        [-18, '#000000', '#020309'],
        [-12, '#01030a', '#0a1228'],
        [-8, '#06102a', '#1b2a52'],
        [-4, '#132a5c', '#5a4a6e'],
        [-1, '#24478a', '#c47a58'],
        [2, '#3366b0', '#e3a374'],
        [8, '#3f7ccc', '#a9cbea'],
        [20, '#4a8fdf', '#b9dbf4'],
        [60, '#4f97e8', '#c3e2f8'],
    ];
    const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const mix = (a, b, t) =>
        `rgb(${rgb(a)
            .map((v, i) => Math.round(v + (rgb(b)[i] - v) * t))
            .join(',')})`;

    function skyColours(sun) {
        if (sun <= SKY[0][0]) {
            return [SKY[0][1], SKY[0][2]];
        }
        for (let i = 1; i < SKY.length; i++) {
            if (sun <= SKY[i][0]) {
                const [e0, z0, h0] = SKY[i - 1];
                const [e1, z1, h1] = SKY[i];
                const t = (sun - e0) / (e1 - e0);
                return [mix(z0, z1, t), mix(h0, h1, t)];
            }
        }
        const last = SKY[SKY.length - 1];
        return [last[1], last[2]];
    }

    // --- what the eye can see ---------------------------------------------------------------------------------------
    // Faintest star magnitude by sun elevation (no moon, high in the sky).
    const LIMIT = [
        [0, -3],
        [-2, -1],
        [-4, 0.5],
        [-6, 1.6],
        [-9, 2.9],
        [-12, 4.0],
        [-15, 4.7],
        [-18, 5.2],
    ];

    /** The faintest magnitude visible right now, high in the sky: twilight, then moonlight. */
    function limitingMag(sun, moon) {
        let lm = LIMIT[LIMIT.length - 1][1];
        if (sun >= LIMIT[0][0]) {
            lm = LIMIT[0][1];
        } else {
            for (let i = 1; i < LIMIT.length; i++) {
                if (sun >= LIMIT[i][0]) {
                    const [e0, m0] = LIMIT[i - 1];
                    const [e1, m1] = LIMIT[i];
                    lm = m0 + ((sun - e0) / (e1 - e0)) * (m1 - m0);
                    break;
                }
            }
        }
        if (moon && moon.el > -2 && sun < -4) {
            // a full moon high up washes out about 1.8 magnitudes
            lm -= 1.8 * moon.lit * Math.min(1, (moon.el + 2) / 30);
        }
        return lm;
    }

    /** Extra magnitudes lost low in the sky, through more air. */
    const extinction = el => Math.min(3, 0.25 * (1 / Math.sin(Math.max(el, 1) * RAD) - 1));

    // --- positions --------------------------------------------------------------------------------------------------
    /** Local sidereal time in hours. */
    function lst(t, lon) {
        const d = t / 86400000 + 2440587.5 - 2451545.0;
        return (((18.697374558 + 24.06570982441908 * d + lon / 15) % 24) + 24) % 24;
    }

    /** Right ascension (hours) / declination → azimuth, elevation (degrees). */
    function horizontal(raH, dec, lat, lstH) {
        const H = (lstH - raH) * 15 * RAD;
        const phi = lat * RAD;
        const d = dec * RAD;
        const sinEl = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
        const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
        const az = Math.atan2(
            -Math.sin(H) * Math.cos(d),
            Math.cos(phi) * Math.sin(d) - Math.sin(phi) * Math.cos(d) * Math.cos(H),
        );
        return { az: (az / RAD + 360) % 360, el: el / RAD };
    }

    /** Direction from home to a point `altM` up at lat/lon, allowing for the curve of the earth. */
    function lookAt(home, lat, lon, altM) {
        const p1 = home.lat * RAD;
        const p2 = lat * RAD;
        const dl = (lon - home.lon) * RAD;
        const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
        const dist = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
        const az = Math.atan2(
            Math.sin(dl) * Math.cos(p2),
            Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
        );
        return {
            az: (az / RAD + 360) % 360,
            el: Math.atan2(altM - (dist * dist) / (2 * EARTH_R), Math.max(dist, 1)) / RAD,
        };
    }

    const unit = p => [
        Math.cos(p.el * RAD) * Math.sin(p.az * RAD),
        Math.cos(p.el * RAD) * Math.cos(p.az * RAD),
        Math.sin(p.el * RAD),
    ];

    /** The direction `deg` degrees from `a` along the great circle towards `b`. */
    function towards(a, b, deg) {
        const u = unit(a);
        const v = unit(b);
        const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        let t = [v[0] - dot * u[0], v[1] - dot * u[1], v[2] - dot * u[2]];
        const n = Math.hypot(t[0], t[1], t[2]);
        if (n < 1e-9) {
            return a; // b is a itself or straight opposite: no direction
        }
        t = t.map(x => x / n);
        const d = deg * RAD;
        const p = u.map((x, i) => x * Math.cos(d) + t[i] * Math.sin(d));
        return {
            az: (Math.atan2(p[0], p[1]) / RAD + 360) % 360,
            el: Math.asin(Math.max(-1, Math.min(1, p[2]))) / RAD,
        };
    }

    /**
     * Compass heading (degrees from north, clockwise) of the top of the screen from a device orientation event, or null
     * when the event has no absolute heading. `screenAngle`: the screen's rotation (0, 90, 180, 270).
     */
    function compassHeading(e, screenAngle) {
        let h = null;
        if (e && typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
            h = e.webkitCompassHeading; // iOS: already a compass heading
        } else if (e && e.absolute && typeof e.alpha === 'number') {
            h = 360 - e.alpha; // alpha turns anticlockwise from north
        }
        if (h === null) {
            return null;
        }
        return (((h + (screenAngle || 0)) % 360) + 360) % 360;
    }

    /** Smooth a heading towards a new reading, the short way round. */
    function smoothHeading(prev, next, k) {
        if (prev == null) {
            return next;
        }
        const d = ((next - prev + 540) % 360) - 180;
        return (((prev + d * k) % 360) + 360) % 360;
    }

    /** Angle between two directions in the sky, degrees. */
    function separation(a, b) {
        const cos =
            Math.sin(a.el * RAD) * Math.sin(b.el * RAD) +
            Math.cos(a.el * RAD) * Math.cos(b.el * RAD) * Math.cos((a.az - b.az) * RAD);
        return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
    }

    /** Where an aircraft will be `dt` seconds later (speed, track and climb held). */
    function ahead(a, dt) {
        if (!a.gs || a.track == null || !(a.alt > 0) || a.stale) {
            return { lat: a.lat, lon: a.lon, alt: a.alt || 0 };
        }
        const d = (a.gs * 1852 * dt) / 3600 / EARTH_R;
        const b = a.track * RAD;
        const p1 = a.lat * RAD;
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
        const l2 =
            a.lon * RAD +
            Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return { lat: p2 / RAD, lon: l2 / RAD, alt: Math.max(0, a.alt + ((a.vr || 0) * dt) / 60) };
    }

    const ALT_COLOURS = [
        [10000, '#7cffa0'],
        [24000, '#5fe8d0'],
        [34000, '#7fd0ff'],
        [Infinity, '#b49cff'],
    ];
    const altColour = a => (a.emergency ? '#ff4d4d' : a.stale ? '#8a9a92' : ALT_COLOURS.find(b => a.alt <= b[0])[1]);

    /** Star colour from its temperature. */
    function starColour(k) {
        if (k >= 20000) {
            return '#bcd2ff';
        }
        if (k >= 9000) {
            return '#dfe8ff';
        }
        if (k >= 6500) {
            return '#ffffff';
        }
        if (k >= 5200) {
            return '#fff2d8';
        }
        if (k >= 4000) {
            return '#ffd9a8';
        }
        return '#ffc08a';
    }

    const PLANET_COLOURS = {
        Mercury: '#d8cbb8',
        Venus: '#fff4d6',
        Mars: '#ff9a6a',
        Jupiter: '#ffe9c4',
        Saturn: '#f2dca0',
    };

    class SkyoramaDome {
        constructor(canvas, options) {
            this.canvas = canvas;
            this.options = Object.assign({ figures: true, labels: true }, options || {});
            this.data = this.options.data || global.SKYORAMA_SKYDATA;
            this.sky = null;
            this.skyReceived = 0;
            this.aircraft = null;
            this.aircraftReceived = 0;
            this.bg = document.createElement('canvas');
            this.bgFor = null;
            this.size = 0;
            this.dpr = 1;
            /** where the top of the picture points (compass heading); 0 = north up */
            this.heading = 0;
        }

        /**
         * Turn the dome so that the top of the picture points to `heading` (degrees from north, e.g. a phone's compass
         * heading); null or 0: north up. Names stay upright.
         */
        setHeading(heading) {
            const h = heading == null || !Number.isFinite(heading) ? 0 : ((heading % 360) + 360) % 360;
            if (Math.abs(((h - this.heading + 540) % 360) - 180) >= 0.5) {
                this.heading = h;
                this.bgFor = null; // the slow layer is redrawn for the new direction
            }
        }

        /**
         * What was drawn nearest to a point on the canvas (CSS pixels, relative to the canvas), within `max` pixels:
         * `{ kind: 'aircraft' | 'satellite', item }`, or null.
         */
        hitAt(x, y, max) {
            let best = null;
            let bestD = (max || 18) ** 2;
            for (const h of this.hits || []) {
                const d = (h.x - x) ** 2 + (h.y - y) ** 2;
                if (d < bestD) {
                    best = h;
                    bestD = d;
                }
            }
            return best && { kind: best.kind, item: best.item };
        }

        /** The answer of `sendTo('skyorama.N', 'sky')`. */
        setSky(sky) {
            this.sky = sky;
            this.skyReceived = Date.now();
            this.bgFor = null;
        }

        /**
         * The answer of `sendTo('skyorama.N', 'aircraft', { radiusNm })`, or null. `positionsAt`: when the positions were
         * taken, in this browser's clock (the answer's `at` corrected for the clock difference); default: now.
         */
        setAircraft(answer, positionsAt) {
            this.aircraft = answer && Array.isArray(answer.ac) ? answer : null;
            this.aircraftReceived = positionsAt || Date.now();
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            const size = Math.floor(Math.min(rect.width, rect.height));
            const dpr = global.devicePixelRatio || 1;
            if (size !== this.size || dpr !== this.dpr) {
                this.size = size;
                this.dpr = dpr;
                this.canvas.width = this.bg.width = size * dpr;
                this.canvas.height = this.bg.height = size * dpr;
                this.bgFor = null;
            }
        }

        // --- projection ---------------------------------------------------------------------------------------------
        radius() {
            return this.size / 2 - 24;
        }

        /** Distance from the middle for an elevation: the low sky (where most aircraft are) gets more room. */
        ringR(el) {
            const e = Math.max(el, 0) / 90;
            return this.radius() * (1 - (Math.sqrt(e) + e) / 2);
        }

        xy(az, el) {
            const r = this.ringR(el);
            const a = (az - this.heading) * RAD;
            return [this.size / 2 + r * Math.sin(a), this.size / 2 - r * Math.cos(a)];
        }

        // --- the slow layer: sky, stars, planets, sun, moon (redrawn when new data arrives) --------------------------
        drawBackground() {
            const s = this.sky;
            const c = this.bg.getContext('2d');
            const size = this.size;
            const cx = size / 2;
            const cy = size / 2;
            const R = this.radius();
            c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            c.clearRect(0, 0, size, size);
            const sun = s.sun.el;
            const [zen, hor] = skyColours(sun);
            const g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
            g.addColorStop(0, zen);
            g.addColorStop(0.5, zen);
            g.addColorStop(1, hor);
            c.save();
            c.beginPath();
            c.arc(cx, cy, R, 0, Math.PI * 2);
            c.clip();
            c.fillStyle = g;
            c.fillRect(0, 0, size, size);

            // Glow around the sun, and on the horizon below it through twilight.
            if (sun > -14) {
                const [sx, sy] = this.xy(s.sun.az, Math.max(sun, 0));
                const strength = sun > 0 ? 0.3 : 0.3 * (1 + sun / 14);
                const glow = c.createRadialGradient(sx, sy, 0, sx, sy, R * (sun > 0 ? 0.5 : 0.8));
                glow.addColorStop(0, `rgba(255, ${sun > 6 ? 245 : 175}, ${sun > 6 ? 215 : 120}, ${strength})`);
                glow.addColorStop(1, 'rgba(255, 175, 120, 0)');
                c.fillStyle = glow;
                c.fillRect(0, 0, size, size);
            }

            const lm = limitingMag(sun, s.moon);
            const lstH = lst(s.at, s.home.lon);
            const lat = s.home.lat;
            const d = this.data;
            const label = (text, x, y, alpha, font) => {
                c.font = font || '500 10px system-ui, sans-serif';
                c.fillStyle = `rgba(235, 240, 255, ${alpha})`;
                const left = x > size * 0.75;
                c.textAlign = left ? 'right' : 'left';
                c.fillText(text, x + (left ? -6 : 6), y - 4);
                c.textAlign = 'left';
            };

            // Constellation figures and names, only once enough of their stars can be seen.
            const figures = this.options.figures ? Math.max(0, Math.min(1, (lm - 3) / 1.2)) : 0;
            if (figures > 0 && d) {
                c.strokeStyle = `rgba(150, 180, 235, ${0.38 * figures})`;
                c.lineWidth = 1;
                c.beginPath();
                for (const k of d.constellations) {
                    for (const line of k[5]) {
                        let prev = null;
                        for (const [ra, dec] of line) {
                            const p = horizontal(ra, dec, lat, lstH);
                            if (prev && prev.el > 0 && p.el > 0) {
                                const [x1, y1] = this.xy(prev.az, prev.el);
                                const [x2, y2] = this.xy(p.az, p.el);
                                c.moveTo(x1, y1);
                                c.lineTo(x2, y2);
                            }
                            prev = p;
                        }
                    }
                }
                c.stroke();
                if (this.options.labels) {
                    c.textAlign = 'center';
                    c.font = '600 9px system-ui, sans-serif';
                    for (const k of d.constellations) {
                        if (k[2] > (lm >= 4.5 ? 2 : 1)) {
                            continue;
                        }
                        const p = horizontal(k[3], k[4], lat, lstH);
                        if (p.el < 5) {
                            continue;
                        }
                        const [x, y] = this.xy(p.az, p.el);
                        c.fillStyle = `rgba(170, 195, 240, ${(k[2] === 1 ? 0.6 : 0.42) * figures})`;
                        c.fillText(k[1].toUpperCase(), x, y);
                    }
                    c.textAlign = 'left';
                }
            }

            // Stars: only those bright enough for this sky.
            if (d) {
                for (const st of d.stars) {
                    if (st[2] > lm) {
                        break; // sorted by magnitude
                    }
                    const p = horizontal(st[0], st[1], lat, lstH);
                    if (p.el <= 0) {
                        continue;
                    }
                    const seen = st[2] + extinction(p.el);
                    if (seen > lm) {
                        continue;
                    }
                    const [x, y] = this.xy(p.az, p.el);
                    c.globalAlpha = Math.min(1, (lm - seen) / 0.8 + 0.3);
                    c.fillStyle = starColour(st[3]);
                    c.beginPath();
                    c.arc(x, y, Math.max(0.6, 2.5 - 0.42 * st[2]), 0, Math.PI * 2);
                    c.fill();
                    if (this.options.labels && st[4] && st[2] < 1.6 && lm - seen > 1) {
                        label(st[4], x, y, 0.5 * c.globalAlpha);
                    }
                }
                c.globalAlpha = 1;
            }

            // Deep-sky objects: clusters in a dark-ish sky, galaxies and nebulae need a properly dark one.
            if (d && this.options.labels) {
                for (const [name, kind, ra, dec, mag] of d.deepSky) {
                    const p = horizontal(ra, dec, lat, lstH);
                    if (p.el <= 5) {
                        continue;
                    }
                    const seen = mag + extinction(p.el) + (kind === 'cluster' ? 0.5 : 1.5);
                    if (seen > lm) {
                        continue;
                    }
                    const a = Math.min(1, (lm - seen) / 1.5 + 0.3);
                    const [x, y] = this.xy(p.az, p.el);
                    c.strokeStyle = `rgba(205, 180, 255, ${0.75 * a})`;
                    c.lineWidth = 1;
                    c.beginPath();
                    if (kind === 'galaxy') {
                        c.ellipse(x, y, 6, 2.6, -0.6, 0, Math.PI * 2);
                    } else if (kind === 'nebula') {
                        c.rect(x - 3.5, y - 3.5, 7, 7);
                    } else {
                        c.setLineDash([1.5, 2]);
                        c.arc(x, y, 5, 0, Math.PI * 2);
                    }
                    c.stroke();
                    c.setLineDash([]);
                    label(name, x + 3, y + 7, 0.65 * a);
                }
            }

            // Planets: point-like, so a little easier to see than stars.
            // near the sun, its glare hides planets: 15° by day, 8° in bright twilight
            const glare = sun > 0 ? 15 : sun > -6 ? 8 : 0;
            for (const p of s.planets) {
                if (p.el <= 0 || separation(p, s.sun) < glare) {
                    continue;
                }
                const seen = p.mag + extinction(p.el) - 0.5;
                if (seen > lm) {
                    continue;
                }
                const [x, y] = this.xy(p.az, p.el);
                c.globalAlpha = Math.min(1, (lm - seen) / 0.8 + 0.4);
                c.fillStyle = PLANET_COLOURS[p.name] || '#fff';
                c.beginPath();
                c.arc(x, y, Math.max(1.8, 3.6 - 0.5 * p.mag), 0, Math.PI * 2);
                c.fill();
                label(p.name, x, y, 0.85 * c.globalAlpha, '600 11px system-ui, sans-serif');
                c.globalAlpha = 1;
            }

            // Moon (visible by day too) and sun.
            if (s.moon.el > 0) {
                const [x, y] = this.xy(s.moon.az, s.moon.el);
                // the lit side faces the sun along the sky (great circle), wherever the sun is, also below the horizon
                const step = towards(s.moon, s.sun, 0.5);
                const [sx, sy] = this.xy(step.az, Math.max(step.el, 0.01));
                this.drawMoon(c, x, y, 9, s.moon.phase, Math.atan2(sy - y, sx - x), sun > -4);
            }
            if (sun > 0) {
                const [x, y] = this.xy(s.sun.az, sun);
                c.fillStyle = '#fff3c4';
                c.shadowColor = '#ffd36a';
                c.shadowBlur = 16;
                c.beginPath();
                c.arc(x, y, 10, 0, Math.PI * 2);
                c.fill();
                c.shadowBlur = 0;
            }
            c.restore();

            // Altitude rings, horizon and compass points.
            c.strokeStyle = 'rgba(255, 255, 255, .14)';
            c.lineWidth = 1;
            c.setLineDash([2, 5]);
            for (const el of [10, 30, 60]) {
                c.beginPath();
                c.arc(cx, cy, this.ringR(el), 0, Math.PI * 2);
                c.stroke();
            }
            c.setLineDash([]);
            c.fillStyle = 'rgba(255, 255, 255, .45)';
            c.font = '10px system-ui, sans-serif';
            for (const el of [10, 30, 60]) {
                c.fillText(`${el}°`, cx + 3, cy - this.ringR(el) - 3);
            }
            c.strokeStyle = 'rgba(255, 255, 255, .4)';
            c.lineWidth = 1.5;
            c.beginPath();
            c.arc(cx, cy, R, 0, Math.PI * 2);
            c.stroke();
            c.fillStyle = 'rgba(255, 255, 255, .75)';
            c.font = '600 12px system-ui, sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            for (const [t, az] of [
                ['N', 0],
                ['E', 90],
                ['S', 180],
                ['W', 270],
            ]) {
                const a = (az - this.heading) * RAD;
                c.fillText(t, cx + (R + 13) * Math.sin(a), cy - (R + 13) * Math.cos(a));
            }
            c.textAlign = 'left';
            c.textBaseline = 'alphabetic';
            this.bgFor = s;
        }

        /** The moon, its lit side turned towards the sun (`toward`: the angle to the sun in the picture). */
        drawMoon(c, x, y, r, phase, toward, daylight) {
            c.save();
            c.translate(x, y);
            c.rotate(toward);
            if (!daylight) {
                // the dark part only shows against a dark sky (earthshine); by day only the lit part is seen
                c.fillStyle = 'rgba(40, 46, 60, .9)';
                c.beginPath();
                c.arc(0, 0, r, 0, Math.PI * 2);
                c.fill();
            }
            const k = Math.cos(phase * RAD); // 1 new … −1 full
            c.fillStyle = '#f4efe0';
            c.beginPath();
            c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
            c.ellipse(0, 0, r * Math.abs(k), r, 0, Math.PI / 2, -Math.PI / 2, k > 0);
            c.fill();
            c.restore();
        }

        // --- the fast layer: satellites and aircraft, moved on between updates ---------------------------------------
        draw(now) {
            this.resize();
            if (this.size < 60 || !this.sky) {
                return;
            }
            const t = now || Date.now();
            if (this.bgFor !== this.sky) {
                this.drawBackground();
            }
            const c = this.canvas.getContext('2d');
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.clearRect(0, 0, this.canvas.width, this.canvas.height);
            c.drawImage(this.bg, 0, 0);
            c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            c.save();
            c.beginPath();
            c.arc(this.size / 2, this.size / 2, this.radius(), 0, Math.PI * 2);
            c.clip();
            this.hits = [];
            this.drawSatellites(c, t);
            this.drawAircraft(c, t);
            c.restore();
        }

        drawSatellites(c, t) {
            const s = this.sky;
            const f = Math.max(0, Math.min(1.5, (t - this.skyReceived) / s.aheadMs));
            for (const o of s.satellites) {
                // satellites you track are always shown (faint when they can't be seen); others only when visible
                if (!o.visible && !o.tracked) {
                    continue;
                }
                const daz = ((o.az2 - o.az + 540) % 360) - 180;
                const az = (o.az + daz * f + 360) % 360;
                const el = o.el + (o.el2 - o.el) * f;
                if (el <= 0) {
                    continue;
                }
                const [x, y] = this.xy(az, el);
                this.hits.push({ kind: 'satellite', item: Object.assign({}, o, { az, el }), x, y });
                c.fillStyle = o.visible ? (o.tracked ? '#ffe08a' : '#ffffff') : 'rgba(210, 220, 235, .45)';
                c.beginPath();
                c.arc(x, y, o.tracked ? 3.5 : 2.3, 0, Math.PI * 2);
                c.fill();
                if (o.tracked || this.options.labels) {
                    c.font = `${o.tracked ? 600 : 500} 11px system-ui, sans-serif`;
                    c.fillStyle = o.tracked
                        ? o.visible
                            ? '#ffe08a'
                            : 'rgba(255, 224, 138, .6)'
                        : 'rgba(255, 255, 255, .75)';
                    const left = x > this.size * 0.75;
                    c.textAlign = left ? 'right' : 'left';
                    c.fillText(o.name, x + (left ? -7 : 7), y - 5);
                    c.textAlign = 'left';
                }
            }
        }

        drawAircraft(c, t) {
            const a = this.aircraft;
            if (!a || !this.sky) {
                return;
            }
            const home = this.sky.home;
            const dt = Math.min(60, Math.max(0, (t - this.aircraftReceived) / 1000));
            for (const p of a.ac) {
                if (!(p.alt > 0)) {
                    continue; // on the ground (or unknown height)
                }
                const now = ahead(p, dt);
                const at = lookAt(home, now.lat, now.lon, now.alt * FT);
                if (at.el <= 0) {
                    continue;
                }
                const next = ahead(p, dt + 60);
                const na = lookAt(home, next.lat, next.lon, next.alt * FT);
                const [x, y] = this.xy(at.az, at.el);
                this.hits.push({ kind: 'aircraft', item: Object.assign({}, p, now), x, y });
                const [nx, ny] = this.xy(na.az, Math.max(0, na.el));
                const col = altColour(p);
                c.strokeStyle = col;
                c.lineWidth = 1.5;
                c.beginPath();
                c.moveTo(x, y);
                c.lineTo(nx, ny);
                c.stroke();
                c.save();
                c.translate(x, y);
                c.rotate(Math.atan2(nx - x, -(ny - y)));
                c.fillStyle = col;
                c.shadowColor = '#000';
                c.shadowBlur = 3;
                c.beginPath();
                c.moveTo(0, -8);
                c.lineTo(6, 6);
                c.lineTo(0, 3);
                c.lineTo(-6, 6);
                c.closePath();
                c.fill();
                c.restore();
                c.font = '600 11px system-ui, sans-serif';
                c.fillStyle = col;
                c.shadowColor = '#000';
                c.shadowBlur = 3;
                const left = x > this.size * 0.75;
                c.textAlign = left ? 'right' : 'left';
                c.fillText(p.flight || p.reg || String(p.hex).toUpperCase(), x + (left ? -10 : 10), y - 2);
                c.textAlign = 'left';
                c.shadowBlur = 0;
            }
        }
    }

    SkyoramaDome.limitingMag = limitingMag;
    SkyoramaDome.horizontal = horizontal;
    SkyoramaDome.skyColours = skyColours;
    SkyoramaDome.separation = separation;
    SkyoramaDome.towards = towards;
    SkyoramaDome.compassHeading = compassHeading;
    SkyoramaDome.smoothHeading = smoothHeading;
    global.SkyoramaDome = SkyoramaDome;
})(window);
