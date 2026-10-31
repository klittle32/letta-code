/** Stop waiting on a mod import/activation; fence its owner separately. */
export function waitForModLoad<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new Error("Mod loading cancelled", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) disposeLate?.(value);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      )
      .catch(reject);
  });
}
