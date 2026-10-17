/*
 * Shared by the Skyorama pages: the connection to ioBroker (the web adapter's socket), sendTo, URL parameters, units
 * and formatting.
 * URL parameters read here: ?instance=0 (Skyorama instance), ?units=km|mi|nm (distances; default km).
 */
(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const instance = `skyorama.${/^\d{1,3}$/.test(params.get('instance') || '') ? params.get('instance') : '0'}`;
    const UNITS = { km: [1.852, 'km'], mi: [1.150779, 'mi'], nm: [1, 'nm'] };
    const units = UNITS[params.get('units')] ? params.get('units') : 'km';

    // The web adapter serves the socket at /socket.io next to the page.
    const socket = window.io(location.origin, { path: '/socket.io', transports: ['websocket', 'polling'] });

    /** sendTo Skyorama; never rejects: errors come back as `{ error }`. */
    const sendTo = (command, message, timeoutMs) =>
        new Promise(resolve => {
            const timer = setTimeout(() => resolve({ error: 'No answer from the adapter' }), timeoutMs || 15_000);
            socket.emit('sendTo', instance, command, message || {}, answer => {
                clearTimeout(timer);
                resolve(answer || { error: 'No answer from the adapter' });
            });
        });

    const esc = s =>
        String(s).replace(
            /[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
        );

    const fmt = {
        /** nautical miles → the chosen unit */
        dist(nm) {
            if (nm == null) {
                return '–';
            }
            const v = nm * UNITS[units][0];
            return `${v.toFixed(v < 10 ? 1 : 0)} ${UNITS[units][1]}`;
        },
        /** a radius step in the chosen unit → nautical miles */
        toNm: v => v / UNITS[units][0],
        unit: UNITS[units][1],
        /** "FL340" from 6,000 ft, below that feet */
        alt(ft) {
            if (ft == null) {
                return '–';
            }
            if (ft <= 0) {
                // "ground", or a barometric altitude at or below zero: on the ground
                return 'On the ground';
            }
            return ft >= 6000
                ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
                : `${Math.round(ft).toLocaleString()} ft`;
        },
        deg: v => (v == null ? '–' : `${String(Math.round(v) % 360).padStart(3, '0')}°`),
        time: t => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    };

    /** Altitude colours for aircraft (as on the dome). */
    const ALT_BANDS = [
        ['Ground', 0, '#c98a3a'],
        ['Below 10,000 ft', 10000, '#7cffa0'],
        ['10–24,000 ft', 24000, '#5fe8d0'],
        ['24–34,000 ft', 34000, '#7fd0ff'],
        ['Above 34,000 ft', Infinity, '#b49cff'],
    ];
    const altColour = a => {
        if (a.emergency) {
            return '#ff4d4d';
        }
        if (a.stale) {
            return '#8a9a92';
        }
        if (a.alt == null) {
            return '#a9b4ae';
        }
        return ALT_BANDS.find(b => a.alt <= b[1])[2];
    };

    /** Where an aircraft will be `dt` seconds later (speed, track and climb held). */
    function ahead(a, dt) {
        if (!a.gs || a.track == null || !(a.alt > 0) || a.stale || dt <= 0) {
            return { lat: a.lat, lon: a.lon, alt: a.alt };
        }
        const R = 6371e3;
        const rad = Math.PI / 180;
        const d = (a.gs * 1852 * dt) / 3600 / R;
        const b = a.track * rad;
        const p1 = a.lat * rad;
        const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
        const l2 =
            a.lon * rad +
            Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
        return { lat: p2 / rad, lon: l2 / rad, alt: Math.max(0, a.alt + ((a.vr || 0) * dt) / 60) };
    }

    /** The status line at the bottom of the page. */
    function status(text) {
        const el = document.getElementById('status');
        if (el) {
            el.textContent = text || '';
            el.hidden = !text;
        }
    }

    /**
     * Call `fn` each time the connection is (re)established. The socket's own 'connect' event is not reliable here (it
     * can fire before a page script listens, or not at all), so the state is also checked twice a second.
     */
    function whenConnected(fn) {
        let was = false;
        const check = () => {
            if (socket.connected && !was) {
                was = true;
                fn();
            } else if (!socket.connected) {
                was = false;
            }
        };
        socket.on('connect', check);
        socket.on('disconnect', check);
        setInterval(check, 500);
        check();
    }

    window.SkyoramaPage = {
        params,
        instance,
        units,
        socket,
        sendTo,
        whenConnected,
        esc,
        fmt,
        ALT_BANDS,
        altColour,
        ahead,
        status,
    };
})();
