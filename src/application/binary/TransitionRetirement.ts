/**
 * The retirement of a transition epoch.
 *
 * Every request of an epoch waits for the epoch's transition chain or for the
 * epoch's retirement. The retirement is shared by the whole epoch, so a
 * request attaches a listener instead of racing a shared promise: a request
 * that settled for another reason detaches its listener, and the retirement
 * keeps nothing for it.
 */
export interface TransitionRetirement {
  /**
   * Attach a listener that runs when the epoch is retired.
   *
   * The returned function detaches the listener. A listener attached after
   * the retirement already happened runs at once, so a request that waits for
   * an epoch that is already retired is released without waiting.
   */
  subscribe(listener: () => void): () => void;
  /** The listeners that are still attached. */
  readonly attached: number;
  /** Retire the epoch, so the requests that wait for it are released. */
  retire(): void;
}

/** Create the retirement of one transition epoch. */
export const createTransitionRetirement = (): TransitionRetirement => {
  const listeners = new Set<() => void>();
  let retired = false;
  return {
    subscribe: (listener: () => void): (() => void) => {
      if (retired) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get attached(): number {
      return listeners.size;
    },
    retire: (): void => {
      if (retired) return;
      retired = true;
      const waiting = [...listeners];
      listeners.clear();
      for (const listener of waiting) listener();
    },
  };
};
