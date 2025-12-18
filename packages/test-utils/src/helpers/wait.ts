/**
 * Wait and Polling Helpers for Testing
 *
 * Utilities for async waiting, polling, and timing in tests.
 */

/**
 * Wait for a specified duration
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for next tick (microtask queue flush)
 */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => process.nextTick(resolve));
}

/**
 * Wait for next event loop iteration (macrotask queue flush)
 */
export function nextLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Flush all pending promises
 */
export async function flushPromises(): Promise<void> {
  await nextTick();
  await nextLoop();
}

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  message?: string;
}

/**
 * Wait for a condition to become true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const { timeout = 5000, interval = 50, message = 'Condition not met within timeout' } = options;

  const startTime = Date.now();

  while (true) {
    const result = await condition();
    if (result) return;

    if (Date.now() - startTime > timeout) {
      throw new Error(message);
    }

    await wait(interval);
  }
}

/**
 * Wait for a value to match expected
 */
export async function waitForValue<T>(
  getValue: () => T | Promise<T>,
  expected: T,
  options: WaitForOptions = {}
): Promise<void> {
  const { message = `Value did not become ${JSON.stringify(expected)} within timeout` } = options;
  await waitFor(async () => (await getValue()) === expected, { ...options, message });
}

/**
 * Wait for a function to return a truthy value and return it
 */
export async function waitForResult<T>(
  getValue: () => T | Promise<T>,
  options: WaitForOptions = {}
): Promise<NonNullable<T>> {
  const {
    timeout = 5000,
    interval = 50,
    message = 'Did not get truthy result within timeout',
  } = options;

  const startTime = Date.now();

  while (true) {
    const result = await getValue();
    if (result) return result as NonNullable<T>;

    if (Date.now() - startTime > timeout) {
      throw new Error(message);
    }

    await wait(interval);
  }
}

/**
 * Wait for an array to reach a certain length
 */
export async function waitForLength<T>(
  getArray: () => T[] | Promise<T[]>,
  length: number,
  options: WaitForOptions = {}
): Promise<T[]> {
  const { message = `Array did not reach length ${length} within timeout` } = options;
  let array: T[] = [];

  await waitFor(
    async () => {
      array = await getArray();
      return array.length >= length;
    },
    { ...options, message }
  );

  return array;
}

/**
 * Wait for a function to not throw
 */
export async function waitForNoThrow(
  fn: () => void | Promise<void>,
  options: WaitForOptions = {}
): Promise<void> {
  const {
    timeout = 5000,
    interval = 50,
    message = 'Function kept throwing within timeout',
  } = options;

  const startTime = Date.now();

  while (true) {
    try {
      await fn();
      return;
    } catch (error) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await wait(interval);
    }
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  backoff?: 'none' | 'linear' | 'exponential';
}

/**
 * Retry a function until it succeeds
 */
export async function retry<T>(fn: () => T | Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, delay = 100, backoff = 'none' } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        let waitTime = delay;
        if (backoff === 'linear') {
          waitTime = delay * attempt;
        } else if (backoff === 'exponential') {
          waitTime = delay * Math.pow(2, attempt - 1);
        }
        await wait(waitTime);
      }
    }
  }

  throw lastError ?? new Error('All retry attempts failed');
}

/**
 * Run a function with a timeout
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeout: number,
  message = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeout)),
  ]);
}

/**
 * Run multiple operations concurrently with a limit
 */
export async function concurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit = 5
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = Promise.resolve().then(async () => {
      const result = await fn(item);
      results.push(result);
    });

    executing.push(p);

    if (executing.length >= limit) {
      await Promise.race(executing);
      // Remove completed promise from tracking array (splice returns removed elements, void to ignore)
      void executing.splice(
        executing.findIndex((e) => e === p),
        1
      );
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Measure execution time of a function
 */
export async function measureTime<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}

/**
 * Assert that a function completes within a time limit
 */
export async function assertFastEnough<T>(
  fn: () => T | Promise<T>,
  maxDuration: number,
  message?: string
): Promise<T> {
  const { result, duration } = await measureTime(fn);

  if (duration > maxDuration) {
    throw new Error(
      message ?? `Operation took ${duration.toFixed(2)}ms, expected < ${maxDuration}ms`
    );
  }

  return result;
}
