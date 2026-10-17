// Reachability of one data source: unreachable only after 2 consecutive failures, and a failing source logs one
// warning (then debug) until it recovers.

export interface HealthLog {
    warn(msg: string): void;
    info(msg: string): void;
    debug(msg: string): void;
}

export class SourceHealth {
    private failures = 0;
    private warned = false;

    public constructor(
        public readonly name: string,
        private readonly log: HealthLog,
    ) {}

    /** Not reachable until a first success (nothing has shown the source works yet). */
    public unproven(): void {
        this.failures = 2;
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
    }

    public fail(err: unknown): void {
        this.failures++;
        const msg = `${this.name}: ${err instanceof Error ? err.message : String(err)}`;
        if (this.warned) {
            this.log.debug(msg);
        } else {
            this.log.warn(msg);
            this.warned = true;
        }
    }
}
