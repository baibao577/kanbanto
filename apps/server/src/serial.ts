/**
 * One at a time per key, in this process (Kanbanto runs as one server): for a check followed by a write, where two
 * requests at once would each pass the check before either wrote (a quota, a sending limit).
 */
const tails = new Map<string, Promise<unknown>>()

export function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve()
  const mine = before.then(work, work)
  const tail = mine.catch(() => {})
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return mine
}
