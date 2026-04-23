export class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit = {},
	timeoutMs = 2500,
): Promise<Response> {
	const controller = new AbortController();
	const originalSignal = init.signal;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const abort = () => {
		controller.abort(new TimeoutError(`Request timed out after ${timeoutMs}ms`));
	};

	if (originalSignal) {
		if (originalSignal.aborted) {
			controller.abort(originalSignal.reason);
		} else {
			originalSignal.addEventListener("abort", () => controller.abort(originalSignal.reason), { once: true });
		}
	}

	try {
		timer = setTimeout(abort, timeoutMs);
		return await fetch(input, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
			throw new TimeoutError(`Request timed out after ${timeoutMs}ms`);
		}

		if (error instanceof TimeoutError) {
			throw error;
		}

		throw error;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
