// HTTP helpers. Every request has a timeout and identifies the adapter.

import { version } from '../../package.json';

export const USER_AGENT = `ioBroker.skyorama/${version} (+https://github.com/AlanSRU/ioBroker.skyorama)`;

/** A non-2xx answer. */
export class HttpError extends Error {
    public constructor(public readonly status: number) {
        super(`HTTP ${status}`);
    }
}

async function get(url: string, timeoutMs: number): Promise<Response> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 404) {
        throw new HttpError(res.status);
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
export async function getJson(url: string, timeoutMs: number): Promise<unknown> {
    const res = await get(url, timeoutMs);
    if (res.status === 404) {
        return null;
    }
    return res.json();
}

export type JsonFetcher = (url: string, timeoutMs: number) => Promise<unknown>;
export type TextFetcher = (url: string, timeoutMs: number) => Promise<string>;
