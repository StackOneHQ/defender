/**
 * Counting semaphore for capping concurrent Tier 3 provider calls.
 * FIFO queue; a queued waiter whose signal aborts leaves the queue.
 */
export class Semaphore {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	/**
	 * Wait for a slot. Resolves to a release function, or `null` when `signal`
	 * aborted before a slot was free.
	 */
	acquire(signal?: AbortSignal): Promise<(() => void) | null> {
		if (signal?.aborted) return Promise.resolve(null);
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(this.makeRelease());
		}
		return new Promise((resolve) => {
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				this.active++;
				resolve(this.makeRelease());
			};
			const onAbort = () => {
				const i = this.queue.indexOf(grant);
				if (i >= 0) this.queue.splice(i, 1);
				resolve(null);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(grant);
		});
	}

	private makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.queue.shift()?.();
		};
	}
}
