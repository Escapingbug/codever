export class SessionCredentialBarrier<T> {
    private pending = Promise.resolve()
    private lastError?: Error

    constructor(private readonly write: (value: T) => Promise<void>) {}

    enqueue(value: T): void {
        this.pending = this.pending
            .then(() => this.write(value))
            .then(() => { this.lastError = undefined })
            .catch(error => {
                this.lastError = error instanceof Error ? error : new Error(String(error))
            })
    }

    async flush(): Promise<void> {
        let observed: Promise<void>
        do {
            observed = this.pending
            await observed
        } while (observed !== this.pending)
        if (this.lastError) throw this.lastError
    }
}
