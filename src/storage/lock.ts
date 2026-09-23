// Serializes work per file path inside this process.
//
// The project's JSON files are all read-modify-written: a tool reads the whole
// document, changes a field, and writes the whole document back. The write
// itself is atomic (temp file + rename), so a reader never sees half a file —
// but that says nothing about two tool calls overlapping. Whenever a handler
// yields between its read and its write, a second call can read the same
// starting state, and whichever writes last silently discards the other's
// change. book_author_from_linkedin is the clearest case: it awaits an HTTP
// fetch with the document already in hand.
//
// Locking the read and the write separately would not help — each is already
// atomic on its own. What has to be held is the span between them, which is
// why the useful unit here is "run this whole read-modify-write with the file
// to yourself" rather than a lock around each helper.
//
// This is deliberately an in-process queue, not a cross-process lock: one
// container serving one project is the deployment this server is built for.
// Two processes sharing a project directory would still race.

type Tail = Promise<void>;

const tails = new Map<string, Tail>();

/**
 * Runs `task` once every task queued earlier for `key` has settled. Tasks for
 * one key run in the order they were requested; different keys never wait on
 * each other.
 *
 * A task that throws rejects its own caller and does not break the queue.
 */
export function withFileLock<T>(key: string, task: () => T | Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();

  // The tail is deliberately a promise that never rejects, so one failed task
  // cannot reject every task queued behind it.
  const result = previous.then(() => task());
  const settled: Tail = result.then(
    () => undefined,
    () => undefined
  );

  tails.set(key, settled);

  // Keep the map from growing one entry per file for the process's lifetime.
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });

  return result;
}

/** Number of paths with work queued. Exposed for tests. */
export function pendingLockCount(): number {
  return tails.size;
}
