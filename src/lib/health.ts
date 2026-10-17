// Reachability of one data source: unreachable only after 2 consecutive failures, and a failing source logs one
// warning (then debug) until it recovers. A source nobody has used yet (an on-demand feed) doesn't count.

export interface HealthLog {
    warn(msg: string): void;
    info(msg: string): void;
    debug(msg: string): void;
}

export class SourceHealth {
    private failures = 0;
    private warned = false;
    private tried = false;

    public constructor(
        public readonly name: string,
        private readonly log: HealthLog,
        /** its state under `info.`, or undefined for sources that don't affect info.connection */
        public readonly id?: string,
    ) {}

    /** Not reachable until a first success (nothing has shown the source works yet). */
    public unproven(): void {
        this.failures = 2;
        this.tried = true;
    }

    /** Asked at least once (or marked unproven): only then does it count for info.connection. */
    public get used(): boolean {
        return this.tried;
    }

    public get reachable(): boolean {
        return this.failures < 2;
    }

    public ok(): void {
        if (this.warned) {
            this.log.info(`${this.name}: reachable again`);
        }
        this.failures = 0;
        this.warned = false;
        this.tried = true;
    }

    public fail(err: unknown): void {
        this.failures++;
        this.tried = true;
        const msg = `${this.name}: ${err instanceof Error ? err.message : String(err)}`;
        if (this.warned) {
            this.log.debug(msg);
        } else {
            this.log.warn(msg);
            this.warned = true;
        }
    }
}
