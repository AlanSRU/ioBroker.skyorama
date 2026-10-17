/*
 * The flight map page: aircraft around home on a map (Leaflet), with their trails and a one-minute heading line,
 * altitude colours, emergencies in red, lost contacts greyed, lightning strikes of the last hour, a choice of range
 * and an information box per aircraft. Map tiles only if configured in the settings; otherwise a plain dark
 * background with range rings.
 * URL parameters: ?radius=50 (initial range in the chosen units), ?units=km|mi|nm, ?instance=0.
 */
(function () {
    'use strict';

    const P = window.SkyoramaPage;
    const L = window.L;
    const POLL_MS = 10_000;
    const LIGHTNING_MS = 30_000;
    const STEPS = { km: [10, 25, 50, 100, 200, 400], mi: [10, 25, 50, 100, 150, 250], nm: [10, 25, 50, 100, 150, 250] };
    const MAX_NM = 250;

    const steps = STEPS[P.units];
    const asked = Number(P.params.get('radius'));
    // ?radius may be any value (in the chosen units); the buttons offer the usual steps
    let range = asked > 0 ? asked : P.units === 'km' ? 50 : 25;
    const radiusNm = () => Math.min(MAX_NM, P.fmt.toNm(range));

    let map = null;
    let home = null;
    let rings = null;
    const tracks = L.layerGroup();
    const planesLayer = L.layerGroup();
    const storms = L.layerGroup();
    const markers = new Map(); // hex → { marker, line }
    let aircraft = []; // the last answer's list
    let positionsAt = 0; // when that list's positions were taken (browser clock)
    let showLightning = true;
    let strikes = [];
    let lightningOn = false;
    let aircraftNote = '';
    let lightningNote = '';
    let strikesTotal = 0;
    let aircraftOn = true;
    let skew = 0; // the adapter's clock minus this browser's
    let pollSeq = 0;
    let starting = false;

    const info = new window.SkyoramaInfo(
        (hex, plane, at) => {
            // a fresher position for the open aircraft, taken at `at` (adapter clock)
            const i = aircraft.findIndex(a => a.hex === hex);
            if (i >= 0) {
                aircraft[i] = Object.assign({}, aircraft[i], plane, { fixedAt: at ? at - skew : Date.now() });
            }
        },
        () => drawAircraft(), // closed: un-highlight
    );

    const label = a => a.flight || a.reg || String(a.hex).toUpperCase();

    /** Attribution text from the settings: escaped, with plain https:// URLs turned into links. */
    function attributionHtml(text) {
        return P.esc(text || '').replace(
            /https:\/\/[^\s<]+/g,
            u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`,
        );
    }

    function drawRings() {
        rings.clearLayers();
        const nm = radiusNm();
        for (const f of [0.25, 0.5, 0.75, 1]) {
            L.circle([home.lat, home.lon], {
                radius: nm * f * 1852,
                color: f === 1 ? '#f6c453' : '#7f8fb0',
                weight: 1,
                opacity: f === 1 ? 0.55 : 0.25,
                fill: false,
                interactive: false,
            }).addTo(rings);
        }
        L.circleMarker([home.lat, home.lon], {
            radius: 5,
            color: '#f6c453',
            fillColor: '#f6c453',
            fillOpacity: 1,
            interactive: false,
        }).addTo(rings);
    }

    function fit() {
        map.fitBounds(L.latLng(home.lat, home.lon).toBounds(radiusNm() * 1852 * 2), { padding: [10, 10] });
    }

    function planeIcon(a, selected) {
        const col = P.altColour(a);
        return L.divIcon({
            className: `sky-plane${a.emergency ? ' emerg' : ''}${selected ? ' sel' : ''}`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            html:
                `<svg viewBox="0 0 24 24" style="transform:rotate(${Number(a.track) || 0}deg)"><path d="M12 2l2 7 7 4v2l-7-2-1 5 3 2v1.5l-4-1-4 1V20l3-2-1-5-7 2v-2l7-4z" fill="${col}"/></svg>` +
                `<b style="color:${col}">${P.esc(label(a))}<i>${a.alt ? P.esc(P.fmt.alt(a.alt)) : ''}</i></b>`,
        });
    }

    /** Rebuild trails and markers from a new answer. */
    function drawAircraft() {
        tracks.clearLayers();
        planesLayer.clearLayers();
        markers.clear();
        for (const a of aircraft) {
            const col = P.altColour(a);
            const selected = a.hex === info.openHex;
            if (a.trail && a.trail.length) {
                L.polyline([...a.trail.map(t => [t[0], t[1]]), [a.lat, a.lon]], {
                    color: col,
                    weight: selected ? 3 : 2,
                    opacity: selected ? 0.9 : 0.55,
                    dashArray: '2 6',
                    interactive: false,
                }).addTo(tracks);
            }
            const line = L.polyline([], { color: col, weight: 1.5, opacity: 0.8, interactive: false }).addTo(tracks);
            const marker = L.marker([a.lat, a.lon], {
                icon: planeIcon(a, selected),
                keyboard: false,
                zIndexOffset: selected || a.emergency ? 1000 : 0,
            })
                .on('click', e => {
                    L.DomEvent.stopPropagation(e);
                    info.showAircraft(a);
                    drawAircraft();
                })
                .addTo(planesLayer);
            markers.set(a.hex, { marker, line });
        }
        moveAircraft();
    }

    /** Move the markers on between answers (speed, track and climb held). */
    function moveAircraft() {
        const now = Date.now();
        for (const a of aircraft) {
            const m = markers.get(a.hex);
            if (!m) {
                continue;
            }
            const dt = Math.min(60, Math.max(0, (now - (a.fixedAt || positionsAt)) / 1000));
            const p = P.ahead(a, dt);
            m.marker.setLatLng([p.lat, p.lon]);
            if (a.alt && a.track != null && a.gs) {
                const n = P.ahead(Object.assign({}, a, p), 60);
                m.line.setLatLngs([
                    [p.lat, p.lon],
                    [n.lat, n.lon],
                ]);
            }
        }
    }

    function drawStrikes() {
        const now = Date.now();
        strikes = strikes.filter(s => now - s.t <= 3600e3); // an hour, as the adapter keeps them
        storms.clearLayers();
        if (!showLightning) {
            return;
        }
        for (const s of strikes) {
            const age = (now - s.t) / 60000;
            if (age > 60) {
                continue;
            }
            L.circleMarker([s.lat, s.lon], {
                radius: 4,
                weight: 0,
                fillColor: age < 10 ? '#fff6a0' : age < 30 ? '#ffb347' : '#c0603a',
                fillOpacity: Math.max(0.25, 1 - age / 60),
                interactive: false,
            }).addTo(storms);
        }
    }

    function updateFooter() {
        const lightning = document.getElementById('lightning');
        if (lightningOn) {
            lightning.hidden = false;
            // the adapter sends the newest strikes of a big storm, with the true count
            // while answers fail, only what is still on the map (and under an hour old) counts
            const n = lightningNote ? strikes.length : Math.max(strikesTotal, strikes.length);
            lightning.textContent = `Lightning${n ? ` · ${n}` : ''}`;
            lightning.setAttribute('aria-pressed', String(showLightning));
        }
        const age = positionsAt ? Math.max(0, Math.round((Date.now() - positionsAt) / 1000)) : null;
        const parts = [aircraftNote || `${aircraft.length} aircraft · updated ${age == null ? '–' : age} s ago`];
        if (lightningNote) {
            parts.push(`Lightning: ${lightningNote}`);
        }
        document.getElementById('summary').textContent = parts.join(' · ');
    }

    async function pollAircraft() {
        if (!map || document.hidden) {
            return;
        }
        if (!aircraftOn) {
            updateFooter();
            return;
        }
        const seq = ++pollSeq;
        const sky = await P.sendTo('sky', {});
        if (!sky.error) {
            skew = sky.at - Date.now();
        }
        const air = await P.sendTo('aircraft', { radiusNm: radiusNm() });
        if (seq !== pollSeq) {
            return; // the range changed meanwhile: a newer answer is on its way
        }
        if (!sky.error || !air.error) {
            P.status(''); // talking to the adapter again (e.g. after a reconnect)
        }
        if (air.error) {
            aircraftNote =
                air.error === 'No aircraft source configured'
                    ? 'No aircraft source is configured (instance settings, Aircraft tab)'
                    : air.error === 'No answer from the adapter'
                      ? `${P.instance} is not answering`
                      : air.error;
            aircraft = [];
        } else {
            aircraftNote = '';
            aircraft = air.ac;
            positionsAt = air.at - skew;
            info.update(aircraft);
        }
        drawAircraft();
        updateFooter();
    }

    async function pollLightning() {
        if (!lightningOn || document.hidden) {
            return;
        }
        const l = await P.sendTo('lightning', {});
        if (l.error) {
            // keep the strikes on screen (a failed answer is not a clear sky), let them age, and say why
            lightningNote =
                l.error === 'No answer from the adapter'
                    ? `${P.instance} is not answering`
                    : l.error === 'Lightning is off'
                      ? 'switched off'
                      : l.error;
        } else {
            P.status('');
            lightningNote = '';
            strikes = l.strikes;
            strikesTotal = l.total != null ? l.total : l.strikes.length;
        }
        drawStrikes();
        updateFooter();
    }

    function buildRangeChips() {
        const box = document.getElementById('ranges');
        box.innerHTML = '';
        for (const v of steps) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip';
            b.textContent = `${v} ${P.fmt.unit}`;
            b.setAttribute('aria-pressed', String(v === range));
            b.addEventListener('click', () => {
                range = v;
                buildRangeChips();
                drawRings();
                fit();
                void pollAircraft();
            });
            box.appendChild(b);
        }
    }

    function buildLegend() {
        document.getElementById('legend').innerHTML = `${P.ALT_BANDS.map(
            b => `<span><i style="background:${b[2]}"></i>${P.esc(b[0])}</span>`,
        ).join('')}<span><i style="background:#ff4d4d"></i>Emergency</span>`;
    }

    async function start() {
        if (map || starting) {
            return;
        }
        starting = true;
        const cfg = await P.sendTo('mapConfig', {});
        starting = false;
        if (map) {
            return;
        }
        if (cfg.error) {
            P.status(cfg.error === 'No answer from the adapter' ? `${P.instance} is not running` : cfg.error);
            setTimeout(() => void start(), POLL_MS);
            return;
        }
        aircraftOn = cfg.aircraft !== false;
        if (!aircraftOn) {
            aircraftNote = 'The aircraft module is off (instance settings, Aircraft tab)';
        }
        P.status('');
        home = cfg.home;
        lightningOn = !!cfg.lightning;
        map = L.map('map', { zoomSnap: 0.25, attributionControl: true });
        if (cfg.tiles) {
            L.tileLayer(cfg.tiles, { maxZoom: 17, attribution: attributionHtml(cfg.attribution) }).addTo(map);
        } else {
            document.getElementById('map').classList.add('radar');
        }
        rings = L.layerGroup().addTo(map);
        storms.addTo(map);
        tracks.addTo(map);
        planesLayer.addTo(map);
        map.on('click', () => {
            info.close();
            drawAircraft();
        });
        drawRings();
        fit();
        buildRangeChips();
        buildLegend();
        document.getElementById('lightning').addEventListener('click', () => {
            showLightning = !showLightning;
            drawStrikes();
            updateFooter();
        });
        await pollAircraft();
        await pollLightning();
        setInterval(() => void pollAircraft(), POLL_MS);
        setInterval(() => void pollLightning(), LIGHTNING_MS);
        setInterval(() => {
            if (!document.hidden) {
                moveAircraft();
                updateFooter();
            }
        }, 1000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                void pollAircraft();
                void pollLightning();
            }
        });
    }

    P.status('Connecting to ioBroker…');
    P.whenConnected(() => {
        if (!map) {
            void start();
        } else {
            P.status(''); // connected again: whatever the page shows next comes from the adapter
            void pollAircraft();
            void pollLightning();
        }
    });
    P.socket.on('disconnect', () => P.status('Connection to ioBroker lost, reconnecting…'));
})();
