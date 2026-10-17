// HTTP helpers. Every request has a timeout and identifies the adapter.

import { version } from '../../package.json';

export const USER_AGENT = `ioBroker.skyorama/${version} (+https://github.com/AlanSRU/ioBroker.skyorama)`;

/** A non-2xx answer; `retryAfterMs` from a Retry-After header (seconds or a date), if any. */
export class HttpError extends Error {
    public constructor(
        public readonly status: number,
        public readonly retryAfterMs: number | null = null,
    ) {
        super(`HTTP ${status}`);
    }
}

/** Retry-After as milliseconds from now (seconds or an HTTP date), or null. */
export function retryAfterOf(header: string | null, now = Date.now()): number | null {
    if (!header) {
        return null;
    }
    const s = Number(header);
    if (Number.isFinite(s) && s >= 0) {
        return s * 1000;
    }
    const t = Date.parse(header);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * How long to leave a source alone after its `failures`-th failure in a row. Rate limited (429): at least a minute,
 * doubling up to 30 minutes, or longer when Retry-After asks for it (up to a day). Anything else (timeouts, refused connections, errors): 2 s, doubling up
 * to 5 minutes, so a source that has stopped answering is not asked over and over.
 */
export function backoffMs(failures: number, err: unknown): number {
    const n = Math.max(1, failures);
    if (err instanceof HttpError && err.status === 429) {
        const own = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(n - 1, 10));
        return Math.max(own, Math.min(24 * 3600_000, err.retryAfterMs ?? 0));
    }
    return Math.min(5 * 60_000, 2_000 * 2 ** Math.min(n - 1, 10));
}

async function get(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(url, {
        headers: { ...headers, 'User-Agent': USER_AGENT },
        // a configured header (an API key) must not follow a redirect to another host
        redirect: Object.keys(headers).length ? 'error' : 'follow',
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 404) {
        throw new HttpError(res.status, retryAfterOf(res.headers.get('retry-after')));
    }
    return res;
}

/** GET a text resource. Throws on network errors, timeouts and non-2xx answers (404 included). */
export async function getText(url: string, timeoutMs: number): Promise<string> {
    const res = await get(url, timeoutMs);
    if (res.status === 404) {
        throw new HttpError(404);
    }
    return res.text();
}

/** GET JSON. null for 404 ("nothing known"); throws on network errors, timeouts, other non-2xx and bad JSON. */
export async function getJson(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<unknown> {
    const res = await get(url, timeoutMs, headers);
    if (res.status === 404) {
        return null;
    }
    return res.json();
}

export type JsonFetcher = (url: string, timeoutMs: number, headers?: Record<string, string>) => Promise<unknown>;
export type TextFetcher = (url: string, timeoutMs: number) => Promise<string>;
