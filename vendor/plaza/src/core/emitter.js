/**
 * A minimal event emitter.
 *
 * The browser already has EventTarget, but it forces every payload through a
 * CustomEvent and out the other side as `e.detail`, which turns a two-argument
 * callback into an unwrapping ceremony at every call site. Fifteen lines buys
 * a nicer API for the whole library.
 *
 * `on` returns an unsubscribe function. Registering a listener and getting
 * back the way to remove it means UI components can tear themselves down
 * without keeping a parallel bookkeeping list of what they subscribed to.
 */
export class Emitter {
  #listeners = new Map()

  /**
   * Subscribe to an event.
   * @returns {() => void} call to unsubscribe
   */
  on(event, fn) {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  /** Subscribe to the next occurrence only. */
  once(event, fn) {
    const off = this.on(event, (...args) => {
      off()
      fn(...args)
    })
    return off
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn)
  }

  /**
   * Emit an event.
   *
   * Listeners are copied before iteration so a handler may unsubscribe itself
   * — or others — mid-emit without the set mutating underneath us. A throwing
   * listener is reported but does not stop the rest: one broken UI component
   * must not be able to silently halt the room's event delivery.
   */
  emit(event, ...args) {
    const set = this.#listeners.get(event)
    if (!set) return

    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch (err) {
        console.error(`plaza: listener for "${event}" threw`, err)
      }
    }
  }

  /** Drop every listener. Called on teardown. */
  clearListeners() {
    this.#listeners.clear()
  }
}
