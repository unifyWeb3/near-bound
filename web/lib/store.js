/**
 * A tiny store. The views subscribe to it, the shell writes to it.
 *
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    /** @returns {T} */
    get() {
      return state;
    },
    /**
     * Merge a patch into the state and tell the subscribers.
     *
     * @param {Partial<T>} patch
     * @returns {T}
     */
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
      return state;
    },
    /**
     * @param {(state: T) => void} listener
     * @returns {() => void} Removes the listener.
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
