/*
 * The dome page: connects to ioBroker through the web adapter's socket, asks Skyorama for the sky (and aircraft, if
 * an aircraft source is configured) every 10 s, and draws the dome about ten times a second.
 * URL parameters: ?instance=0 (Skyorama instance), ?radius=30 (aircraft radius in nautical miles),
 * ?figures=0 (no constellation figures), ?labels=0 (no names), ?at=22:00 (the next 22:00) or ?at=2026-10-24T22:00
 * (another time, within a week; live aircraft are left out then).
 */
(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const instance = `skyorama.${/^\d{1,3}$/.test(params.get('instance') || '') ? params.get('instance') : '0'}`;
    const radiusNm = Math.min(250, Math.max(1, Number(params.get('radius')) || 30));
    /** ?at=22:00 (the next 22:00) or a date and time; limited to a week, as the adapter does */
    function shownAt(text) {
        if (!text) {
            return NaN;
        }
        const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (hm) {
            const d = new Date();
            d.setHours(+hm[1], +hm[2], 0, 0);
            if (d.getTime() < Date.now()) {
                d.setDate(d.getDate() + 1); // by calendar date: right across a clock change too
            }
            return d.getTime();
        }
        return Date.parse(text);
    }
    const WEEK = 7 * 86400000;
    const atParam = shownAt(params.get('at'));
    const wanted = Number.isFinite(atParam) ? atParam - Date.now() : 0;
    /** how far the shown time is from now (0 = live) */
    const offset = Math.max(-WEEK, Math.min(WEEK, wanted));
    const note = offset !== wanted ? ' (limited to a week from now)' : '';
    const POLL_MS = 10_000;
    const FRAME_MS = 100;

    const canvas = document.getElementById('dome');
    const status = document.getElementById('status');
    const clock = document.getElementById('clock');
    const dome = new window.SkyoramaDome(canvas, {
        figures: params.get('figures') !== '0',
        labels: params.get('labels') !== '0',
    });

    const show = text => {
        status.textContent = text || '';
        status.hidden = !text;
    };

    // The web adapter serves the socket at /socket.io next to this page.
    const socket = window.io(location.origin, { path: '/socket.io', transports: ['websocket', 'polling'] });
    const sendTo = (command, message) =>
        new Promise(resolve => {
            const timer = setTimeout(() => resolve({ error: 'No answer from the adapter' }), 15_000);
            socket.emit('sendTo', instance, command, message, answer => {
                clearTimeout(timer);
                resolve(answer || { error: 'No answer from the adapter' });
            });
        });

    let aircraftOn = true;
    async function poll() {
        if (!socket.connected) {
            show('Connecting to ioBroker…');
            return;
        }
        const sky = await sendTo('sky', offset ? { at: Date.now() + offset } : {});
        if (sky.error) {
            show(sky.error === 'No answer from the adapter' ? `${instance} is not running` : sky.error);
            return;
        }
        show('');
        dome.setSky(sky);
        // the adapter's clock against this browser's (live only: then sky.at is the adapter's "now")
        const skew = offset ? 0 : sky.at - Date.now();
        if (aircraftOn && !offset) {
            const air = await sendTo('aircraft', { radiusNm });
            // no source configured or the module is off: stop asking (until the page is reloaded)
            if (air.error === 'No aircraft source configured' || air.error === 'Aircraft module is off') {
                aircraftOn = false;
            }
            // positions are as old as the adapter's last area answer: move them on from then
            dome.setAircraft(air.error ? null : air, air.error ? undefined : air.at - skew);
        }
    }

    socket.on('connect', () => void poll());
    socket.on('disconnect', () => show('Connection to ioBroker lost, reconnecting…'));
    // a hidden page asks for nothing (aircraft polling on the adapter stops when nobody asks)
    setInterval(() => {
        if (!document.hidden) {
            void poll();
        }
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            void poll();
        }
    });

    setInterval(() => {
        if (document.hidden) {
            return;
        }
        try {
            dome.draw();
        } catch (err) {
            // shown on the page: a dome that silently stays blank helps nobody
            show(`Drawing failed: ${err && err.message ? err.message : err}`);
        }
        const shown = new Date(Date.now() + offset);
        clock.textContent = offset
            ? shown.toLocaleString([], {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
              }) + note
            : shown.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, FRAME_MS);
    show('Connecting to ioBroker…');
})();
