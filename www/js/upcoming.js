/*
 * The "upcoming" page: tonight from sunset to sunrise as one timeline (the sky's colour, cloud, the moon, the planets,
 * satellite passes and meteors), then a dated list of what is coming up: meteor shower peaks, eclipses, moon phases and
 * planet events. From the adapter's `upcoming` command, refreshed every 10 minutes.
 * URL parameters: ?instance=0 (Skyorama instance).
 */
(function () {
    'use strict';

    const P = window.SkyoramaPage;
    const e = P.esc;
    const skyColour = sun => window.SkyoramaDome.skyColours(sun)[0];
    const REFRESH_MS = 10 * 60_000;
    const SVG = 'http://www.w3.org/2000/svg';

    const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const year = t => new Date(t).getFullYear();
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const compass = az => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];

    let last = null;

    // --- the timeline ---------------------------------------------------------------------------------------------

    const LABEL_W = 92;
    const ROW = 22;

    function el(name, attrs, text) {
        const n = document.createElementNS(SVG, name);
        for (const [k, v] of Object.entries(attrs)) {
            n.setAttribute(k, String(v));
        }
        if (text != null) {
            n.textContent = text;
        }
        return n;
    }

    /** Stretches of samples where `ok(i)` holds, as [first, last] index pairs. */
    function runs(n, ok) {
        const out = [];
        let start = -1;
        for (let i = 0; i <= n; i++) {
            if (i < n && ok(i)) {
                if (start < 0) {
                    start = i;
                }
            } else if (start >= 0) {
                out.push([start, i - 1]);
                start = -1;
            }
        }
        return out;
    }

    function drawNight(a) {
        const svg = document.getElementById('night');
        const tl = a.timeline;
        const width = Math.max(320, svg.clientWidth || 800);
        const plotW = width - LABEL_W;
        const x = t => LABEL_W + ((t - tl.from) / (tl.to - tl.from)) * plotW;
        const n = tl.sun.length;
        const sampleW = plotW / Math.max(1, n - 1);
        const sampleX = i => LABEL_W + i * sampleW - sampleW / 2;
        const px = v => v - LABEL_W; // inside the clipped plot area
        svg.replaceChildren();
        const defs = el('defs', {});
        svg.append(defs);
        let gradients = 0;
        /** A left-to-right gradient over samples i0…i1, one stop per sample; returns the fill reference. */
        const gradient = (i0, i1, colour, opacity) => {
            const id = `g${gradients++}`;
            const g = el('linearGradient', {
                id,
                gradientUnits: 'userSpaceOnUse',
                x1: px(sampleX(i0) + sampleW / 2),
                x2: px(sampleX(i1) + sampleW / 2),
                y1: 0,
                y2: 0,
            });
            for (let i = i0; i <= i1; i++) {
                g.append(
                    el('stop', {
                        offset: i1 > i0 ? (i - i0) / (i1 - i0) : 0,
                        'stop-color': colour(i),
                        'stop-opacity': opacity(i),
                    }),
                );
            }
            defs.append(g);
            return `url(#${id})`;
        };
        let y = 18;

        // hours along the top
        const every = width < 600 ? 3 : 2;
        for (let t = Math.ceil(tl.from / 3600_000) * 3600_000; t <= tl.to; t += 3600_000) {
            if (new Date(t).getHours() % every === 0) {
                svg.append(el('text', { x: x(t), y: 12, 'text-anchor': 'middle', class: 'small' }, hm(t)));
                svg.append(
                    el('line', { x1: x(t), x2: x(t), y1: 16, y2: 20, stroke: '#dfe6f3', 'stroke-opacity': 0.3 }),
                );
            }
        }
        y += 6;

        // the sky's colour, as on the dome
        const skyTop = y;
        const plot = el('svg', { x: LABEL_W, y: 0, width: plotW, height: 2000, overflow: 'hidden' });
        svg.append(el('text', { x: 0, y: y + 21, class: 'label' }, 'Sky'));
        plot.append(
            el('rect', {
                x: 0,
                y,
                width: plotW,
                height: 32,
                fill: gradient(
                    0,
                    n - 1,
                    i => skyColour(tl.sun[i]),
                    () => 1,
                ),
            }),
        );
        y += 32 + 10;

        // cloud: grey over the hours it covers, the cloudier the brighter
        if (a.forecastEnabled) {
            svg.append(el('text', { x: 0, y: y + 15, class: 'label' }, 'Cloud %'));
            const hours = a.forecast.filter(h => h.t + 3600_000 > tl.from && h.t < tl.to);
            if (!hours.length) {
                svg.append(el('text', { x: LABEL_W, y: y + 15, class: 'small' }, 'No forecast yet'));
            }
            for (const h of hours) {
                const x0 = Math.max(LABEL_W, x(h.t));
                const x1 = Math.min(LABEL_W + plotW, x(h.t + 3600_000));
                plot.append(
                    el('rect', {
                        x: px(x0),
                        y,
                        width: Math.max(0, x1 - x0 - 1),
                        height: ROW - 2,
                        rx: 2,
                        fill: '#b8c2d4',
                        'fill-opacity': 0.06 + 0.8 * (h.cloud / 100),
                    }),
                );
                if (x1 - x0 > 22) {
                    svg.append(
                        el(
                            'text',
                            { x: (x0 + x1) / 2, y: y + 14, 'text-anchor': 'middle', class: 'small' },
                            String(Math.round(h.cloud)),
                        ),
                    );
                }
            }
            y += ROW + 8;
        }

        // a bar while a body is up, brighter the higher it is (faint in daylight); its highest point labelled
        const bodyRow = (label, alts, colour) => {
            const up = runs(n, i => alts[i] > 0);
            if (!up.length) {
                return;
            }
            svg.append(el('text', { x: 0, y: y + 14, class: 'label' }, label));
            svg.append(
                el('line', {
                    x1: LABEL_W,
                    x2: LABEL_W + plotW,
                    y1: y + 10,
                    y2: y + 10,
                    stroke: '#dfe6f3',
                    'stroke-opacity': 0.07,
                }),
            );
            for (const [i0, i1] of up) {
                plot.append(
                    el('rect', {
                        x: px(sampleX(i0) + sampleW / 2),
                        y: y + 5,
                        width: Math.max(2, (i1 - i0) * sampleW),
                        height: 10,
                        rx: 3,
                        // brighter the higher it is; faint while the sky is too bright to see it
                        fill: gradient(
                            i0,
                            i1,
                            () => colour,
                            i => (tl.sun[i] < -6 ? 1 : 0.3) * (0.25 + 0.75 * Math.min(1, alts[i] / 50)),
                        ),
                    }),
                );
                let top = i0;
                for (let i = i0; i <= i1; i++) {
                    if (alts[i] > alts[top]) {
                        top = i;
                    }
                }
                if ((i1 - i0) * sampleW > 40) {
                    const tx = Math.min(LABEL_W + plotW - 14, Math.max(LABEL_W + 14, x(tl.from + top * tl.step)));
                    svg.append(
                        el(
                            'text',
                            { x: tx, y: y + 1, 'text-anchor': 'middle', class: 'small' },
                            `${Math.round(alts[top])}°`,
                        ),
                    );
                }
            }
            y += ROW + 6;
        };
        const moon = a.tonight.moon;
        bodyRow(moon ? `Moon ${moon.illumination} %` : 'Moon', tl.moon, '#f2efe4');
        const PLANET_COLOURS = {
            mercury: '#c9b8a6',
            venus: '#fff4d6',
            mars: '#ff9466',
            jupiter: '#f1d9b0',
            saturn: '#e8d49a',
        };
        for (const p of tl.planets) {
            // only what gets clear of the horizon while it is dark
            if (p.alt.some((v, i) => v > 8 && tl.sun[i] < -6)) {
                bodyRow(p.name, p.alt, PLANET_COLOURS[p.key] || '#ffffff');
            }
        }

        // satellite passes and meteors: a row of marks each, labels staggered where they would overlap
        const markRow = (label, marks) => {
            const shown = marks.filter(m => m.t >= tl.from && m.t <= tl.to).sort((p, q) => p.t - q.t);
            if (!shown.length) {
                return;
            }
            svg.append(el('text', { x: 0, y: y + 14, class: 'label' }, label));
            const ends = []; // per line of labels: where the last one ends
            for (const m of shown) {
                const mx = x(m.t);
                const textW = m.text.length * 6.2;
                const anchor = mx + 8 + textW > LABEL_W + plotW ? 'end' : 'start';
                const left = anchor === 'end' ? mx - 8 - textW : mx;
                let line = ends.findIndex(end => left > end + 6);
                if (line < 0) {
                    line = ends.length;
                }
                ends[line] = anchor === 'end' ? mx : mx + 8 + textW;
                const g = el('g', {});
                g.append(el('title', {}, m.title));
                g.append(el('path', { d: `M${mx},${y + 4 + line * 15} l5,9 h-10 z`, class: 'hi' }));
                g.append(
                    el(
                        'text',
                        {
                            x: anchor === 'end' ? mx - 8 : mx + 8,
                            y: y + 13 + line * 15,
                            class: 'small hi',
                            'text-anchor': anchor,
                        },
                        m.text,
                    ),
                );
                svg.append(g);
            }
            y += ROW + (ends.length - 1) * 15 + 4;
        };
        markRow(
            'Satellites',
            a.passes.map(s => ({
                t: s.start,
                text: `${s.sat} ${hm(s.start)}`,
                title: `${s.sat}: visible ${hm(s.start)}–${hm(s.end)}, ${compass(s.fromAz)} to ${compass(s.toAz)}, highest ${s.maxEl}°`,
            })),
        );
        markRow(
            'Meteors',
            ((a.meteors && a.meteors.active) || [])
                .filter(m => m.bestAt && m.rateTonight > 0)
                .map(m => ({
                    t: m.bestAt,
                    text: `${m.name} ~${m.rateTonight}/h`,
                    title: `${m.name}: about ${m.rateTonight} an hour around ${hm(m.bestAt)}`,
                })),
        );

        // darkness and now, across all rows
        const bottom = y;
        if (a.tonight.dark) {
            for (const t of [a.tonight.dark.from, a.tonight.dark.to]) {
                plot.append(
                    el('line', {
                        x1: px(x(t)),
                        x2: px(x(t)),
                        y1: skyTop,
                        y2: bottom,
                        stroke: '#9cc4ff',
                        'stroke-opacity': 0.35,
                        'stroke-dasharray': '3 3',
                    }),
                );
            }
        }
        if (a.at > tl.from && a.at < tl.to) {
            plot.append(
                el('line', {
                    x1: px(x(a.at)),
                    x2: px(x(a.at)),
                    y1: skyTop - 4,
                    y2: bottom,
                    stroke: '#ffffff',
                    'stroke-opacity': 0.8,
                }),
            );
            svg.append(el('text', { x: x(a.at), y: bottom + 12, 'text-anchor': 'middle', class: 'small' }, 'now'));
        }
        svg.insertBefore(plot, svg.firstChild);
        svg.setAttribute('height', String(bottom + 16));
    }

    // --- the words above and the list below ---------------------------------------------------------------------

    function summary(a) {
        const n = a.tonight;
        const date = new Date(a.timeline.from).toLocaleDateString([], {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
        });
        document.getElementById('title').textContent = `Tonight · ${date}`;
        const parts = [];
        if (n.dark) {
            parts.push(`Dark from <b>${e(hm(n.dark.from))}</b> to <b>${e(hm(n.dark.to))}</b>.`);
        } else {
            parts.push('It does not get properly dark tonight.');
        }
        for (const line of a.tonightLines) {
            parts.push(`${e(line)}.`);
        }
        const tl = a.timeline;
        for (const p of a.passes.filter(q => q.start >= tl.from && q.start <= tl.to)) {
            parts.push(
                `<b>${e(p.sat)}</b> passes at <b>${e(hm(p.start))}</b>, ${compass(p.fromAz)} to ${compass(p.toAz)}, highest ${p.maxEl}°.`,
            );
        }
        document.getElementById('summary').innerHTML = parts.join(' ');
        document.getElementById('deepsky').textContent = n.deepSky.length
            ? `Well placed for binoculars or a telescope: ${n.deepSky.map(d => d.name).join(', ')}.`
            : '';
    }

    function list(a) {
        const rows = [];
        const now = a.at;
        const when = t => (year(t) === year(now) ? day(t) : `${day(t)} ${year(t)}`);
        const add = (t, html, hi, note) =>
            rows.push({
                t,
                html: `<li${hi ? ' class="hi"' : ''}><time>${e(when(t))}</time><span>${html}${
                    note ? `<small>${note}</small>` : ''
                }</span></li>`,
            });
        const m = a.meteors;
        if (m) {
            for (const s of m.active) {
                add(
                    s.peak,
                    `<b>${e(s.name)}</b> peak${s.peak < now ? ' (still active)' : ''}`,
                    true,
                    `Up to ${s.zhr} meteors an hour under a perfect sky`,
                );
            }
            if (m.next) {
                add(
                    m.next.peak,
                    `<b>${e(m.next.name)}</b> peak`,
                    true,
                    `Up to ${m.next.zhr} meteors an hour under a perfect sky`,
                );
            }
        }
        const x = a.eclipses;
        if (x && x.solar) {
            add(
                x.solar.peak,
                `<b>${e(cap(x.solar.kind))} solar eclipse</b>, ${x.solar.obscuration} % of the sun covered`,
                true,
                `${e(hm(x.solar.start))}–${e(hm(x.solar.end))}, greatest at ${e(hm(x.solar.peak))}, sun ${
                    x.solar.altitude
                }° up. Never look at the sun without eclipse glasses.`,
            );
        }
        if (x && x.lunar) {
            add(
                x.lunar.peak,
                `<b>${e(cap(x.lunar.kind))} lunar eclipse</b>`,
                true,
                `Greatest at ${e(hm(x.lunar.peak))}${
                    x.lunar.partialMinutes ? `, partial phase ${Math.round(x.lunar.partialMinutes)} min` : ''
                }`,
            );
        }
        for (const ev of a.events) {
            const hi = ev.type === 'supermoon' || ev.type === 'opposition' || ev.type === 'elongation';
            add(ev.at, hi ? `<b>${e(ev.text)}</b>` : e(ev.text), hi, e(hm(ev.at)));
        }
        for (const p of a.passes) {
            add(
                p.start,
                `<b>${e(p.sat)}</b> visible pass, highest ${p.maxEl}°`,
                true,
                `${e(hm(p.start))}–${e(hm(p.end))}, ${compass(p.fromAz)} to ${compass(p.toAz)}`,
            );
        }
        rows.sort((p, q) => p.t - q.t);
        document.getElementById('list').innerHTML = rows.map(r => r.html).join('');
    }

    function render() {
        summary(last);
        drawNight(last);
        list(last);
        document.getElementById('updated').textContent = `Updated ${hm(last.at)}${
            last.forecastEnabled ? ' · Cloud forecast: Open-Meteo' : ''
        }`;
    }

    async function load() {
        const a = await P.sendTo('upcoming');
        if (a.error) {
            P.status(a.error);
            return;
        }
        P.status('');
        last = a;
        render();
    }

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => last && drawNight(last), 150);
    });
    P.status('Connecting…');
    P.whenConnected(() => void load());
    setInterval(() => void load(), REFRESH_MS);
})();
