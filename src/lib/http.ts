// HTTP helpers. Every request has a timeout and identifies the adapter.

import { version } from '../../package.json';

export const USER_AGENT = `ioBroker.skyorama/${version} (+https://github.com/AlanSRU/ioBroker.skyorama)`;

/**
 * GET a text resource. Throws on network errors, timeouts and non-2xx answers.
 */
export async function getText(url: string, timeoutMs: number): Promise<string> {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return res.text();
}
