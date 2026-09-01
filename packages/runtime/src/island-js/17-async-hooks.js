    /* node:async_hooks — the two classes CLIs actually construct
     * (AsyncLocalStorage, AsyncResource) with SYNC-FRAME semantics:
     * run() scopes the store for the synchronous call (plus anything
     * it calls); the store does NOT survive across engine awaits the
     * way Node's continuation tracking preserves it (documented
     * divergence — the island has no promise-hook machinery). The
     * hook/id surface is inert: createHook returns a disabled hook,
     * ids are constants. */
  builtins.async_hooks = memo(() => {
    class AsyncLocalStorage {
      constructor() { this._stack = []; this._entered = undefined; }
      run(store, fn, ...args) {
        this._stack.push(store);
        try { return fn(...args); }
        finally { this._stack.pop(); }
      }
      exit(fn, ...args) { return this.run(undefined, fn, ...args); }
      getStore() {
        if (this._stack.length > 0) return this._stack[this._stack.length - 1];
        return this._entered;
      }
      enterWith(store) { this._entered = store; }
      disable() { this._stack = []; this._entered = undefined; }
      static bind(fn) { return fn; }
      static snapshot() { return (cb, ...args) => cb(...args); }
    }
    class AsyncResource {
      constructor(type, opts) { this.type = String(type); void opts; }
      runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
      bind(fn, thisArg) {
        const res = this;
        return function bound(...args) { return res.runInAsyncScope(fn, thisArg === undefined ? this : thisArg, ...args); };
      }
      static bind(fn, type, thisArg) { return new AsyncResource(type || 'bound-anonymous-fn').bind(fn, thisArg); }
      emitDestroy() { return this; }
      asyncId() { return 1; }
      triggerAsyncId() { return 0; }
    }
    const ah = {
      AsyncLocalStorage, AsyncResource,
      executionAsyncId: () => 1,
      triggerAsyncId: () => 0,
      executionAsyncResource: () => ({}),
      createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    };
    ah.default = ah;
    return ah;
  });
