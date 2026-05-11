/**
 * Run async work with a fixed concurrency limit.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 */
export async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return

  let index = 0
  const limit = Math.max(1, concurrency)

  async function runOne() {
    while (index < items.length) {
      const i = index++
      await worker(items[i])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runOne()),
  )
}
