/**
 * Runs `fn` over `items` with at most `limit` calls in flight, returning the
 * results in input order. The workers share one iterator, so a slow item holds
 * up only its own worker.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const queue = items.entries();
  const results: R[] = [];
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
