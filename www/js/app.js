/*
 * The dome page: connects to ioBroker through the web adapter's socket, asks Skyorama for the sky (and aircraft, if
 * an aircraft source is configured) every 10 s, and draws the dome about ten times a second.
 * URL parameters: ?instance=0 (Skyorama instance), ?units=km|mi|nm, ?radius=50 (aircraft radius in those units),
 * ?heading=90 (a fixed direction at the top, e.g. for a wall screen facing east), ?figures=0 (no constellation figures), ?labels=0 (no names), ?at=22:00 (the next 22:00) or ?at=2026-10-24T22:00
 * (another time, within a week; live aircraft are left out then).
 */
(function () {
    'use strict';

    const P = window.SkyoramaPage;
    const params = P.params;
    const instance = P.instance;
    // ?radius in the chosen units (as on the map); default about 50 km
    const radiusNm = Math.min(
        250,
        Math.max(1, P.fmt.toNm(Number(params.get('radius')) || (P.units === 'km' ? 50 : 30))),
    );
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
    const clock = document.getElementById('clock');
    const dome = new window.SkyoramaDome(canvas, {
        figures: params.get('figures') !== '0',
        labels: params.get('labels') !== '0',
    });

    // for embedding and debugging: the dome object of this page
    window.skyoramaDome = dome;
    const show = P.status;
    const socket = P.socket;
    const sendTo = P.sendTo;

    // Tap or click an aircraft or satellite for its details.
    const info = new window.SkyoramaInfo();
    canvas.addEventListener('click', e => {
        const r = canvas.getBoundingClientRect();
        const hit = dome.hitAt(e.clientX - r.left, e.clientY - r.top, 20);
        if (!hit) {
            info.close();
        } else if (hit.kind === 'aircraft') {
            info.showAircraft(hit.item);
        } else {
            info.showSatellite(hit.item);
        }
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
            if (!air.error) {
                info.update(air.ac);
            }
        }
    }

    P.whenConnected(() => void poll());
    socket.on('disconnect', () => show('Connection to ioBroker lost, reconnecting…'));
    // A fixed direction at the top (wall screens), used whenever the compass is off.
    const fixedHeading = Number.isFinite(Number(params.get('heading'))) ? Number(params.get('heading')) : 0;
    dome.setHeading(fixedHeading);

    // Compass: on phones and tablets, turn the dome so that its north points to real north. Browsers give pages the
    // compass only over HTTPS; iOS also asks for permission, which needs a tap.
    const compassBtn = document.getElementById('compass');
    let heading = null;
    let lastReading = 0;
    const onOrientation = e => {
        const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
        const h = window.SkyoramaDome.compassHeading(e, angle);
        if (h !== null) {
            heading = window.SkyoramaDome.smoothHeading(heading, h, 0.25);
            lastReading = Date.now();
            dome.setHeading(heading);
        }
    };
    const compassOff = () => {
        window.removeEventListener('deviceorientationabsolute', onOrientation);
        window.removeEventListener('deviceorientation', onOrientation);
        heading = null;
        dome.setHeading(fixedHeading);
        compassBtn.setAttribute('aria-pressed', 'false');
    };
    // only on touch devices: desktop browsers know the event but have no compass
    if ('DeviceOrientationEvent' in window && navigator.maxTouchPoints > 0) {
        compassBtn.hidden = false;
        compassBtn.addEventListener('click', async () => {
            if (compassBtn.getAttribute('aria-pressed') === 'true') {
                compassOff();
                return;
            }
            if (!window.isSecureContext) {
                show('The compass works only when this page is opened over HTTPS');
                return;
            }
            const DOE = window.DeviceOrientationEvent;
            if (typeof DOE.requestPermission === 'function') {
                try {
                    if ((await DOE.requestPermission()) !== 'granted') {
                        show('No permission to use the compass');
                        return;
                    }
                } catch {
                    show('No permission to use the compass');
                    return;
                }
            }
            compassBtn.setAttribute('aria-pressed', 'true');
            lastReading = 0;
            window.addEventListener('deviceorientationabsolute', onOrientation);
            window.addEventListener('deviceorientation', onOrientation);
            setTimeout(() => {
                if (!lastReading && compassBtn.getAttribute('aria-pressed') === 'true') {
                    compassOff();
                    show('No compass reading from this device');
                }
            }, 3000);
        });
    }

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
