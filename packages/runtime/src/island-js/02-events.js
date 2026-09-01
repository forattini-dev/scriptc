    /* Node's events module: the emitter surface streams and CLIs drive —
     * prepend/once/remove with listener-unwrap, maxListeners bookkeeping
     * (warnings are not emitted), eventNames/rawListeners, Node's
     * unhandled-'error' throw, and the once/getEventListeners statics. */
  builtins.events = memo(() => {
    class EventEmitter {
      constructor() { this._events = Object.create(null); this._maxListeners = undefined; }
    /* Node materializes _events LAZILY inside the methods, not only in the
     * constructor — which is what lets EventEmitter.prototype be MIXED
     * onto an object that never ran it. express does exactly that
     * (merge-descriptors copies the prototype onto the `app` function),
     * so every method here reaches the store through _ev(). */
      _ev() {
        let e = this._events;
        if (e === undefined || e === null) { e = Object.create(null); this._events = e; }
        return e;
      }
      _add(n, f, prepend) {
        if (typeof f !== 'function') {
          const e = new TypeError('The "listener" argument must be of type function. Received ' + (f === null ? 'null' : typeof f));
          e.code = 'ERR_INVALID_ARG_TYPE';
          throw e;
        }
        this.emit('newListener', n, f.listener !== undefined ? f.listener : f);
        const ev = this._ev();
        const a = ev[n] = ev[n] || [];
        if (prepend) a.unshift(f); else a.push(f);
        return this;
      }
      on(n, f) { return this._add(n, f, false); }
      addListener(n, f) { return this.on(n, f); }
      prependListener(n, f) { return this._add(n, f, true); }
      _wrapOnce(n, f) {
        const g = (...a) => { this.removeListener(n, g); f.apply(this, a); };
        g.listener = f;
        return g;
      }
      once(n, f) { return this._add(n, this._wrapOnce(n, f), false); }
      prependOnceListener(n, f) { return this._add(n, this._wrapOnce(n, f), true); }
      removeListener(n, f) {
        const a = this._ev()[n];
        if (a) {
          const i = a.findIndex((x) => x === f || x.listener === f);
          if (i >= 0) {
            const x = a[i];
            a.splice(i, 1);
            if (a.length === 0) delete this._events[n];
            this.emit('removeListener', n, x.listener !== undefined ? x.listener : x);
          }
        }
        return this;
      }
      off(n, f) { return this.removeListener(n, f); }
      removeAllListeners(n) {
        if (n === undefined) this._events = Object.create(null);
        else delete this._ev()[n];
        return this;
      }
      setMaxListeners(m) { this._maxListeners = m; return this; }
      getMaxListeners() { return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners; }
      emit(n, ...args) {
        const a = this._ev()[n];
        if (!a || a.length === 0) {
          if (n === 'error') {
    /* Node throws the unhandled error payload (or a synthetic one) —
     * inside the island this crosses the bridge like any engine throw. */
            const err = args[0];
            if (err instanceof Error) throw err;
            const e = new Error("Unhandled error." + (err === undefined ? '' : ' (' + String(err) + ')'));
            e.code = 'ERR_UNHANDLED_ERROR';
            e.context = err;
            throw e;
          }
          return false;
        }
        for (const f of a.slice()) f.apply(this, args);
        return true;
      }
      listenerCount(n) { const a = this._ev()[n]; return a ? a.length : 0; }
      listeners(n) {
        const a = this._ev()[n];
        return a ? a.map((x) => (x.listener !== undefined ? x.listener : x)) : [];
      }
      rawListeners(n) { const a = this._ev()[n]; return a ? a.slice() : []; }
      eventNames() { return Object.keys(this._ev()); }
    }
    EventEmitter.defaultMaxListeners = 10;
    EventEmitter.errorMonitor = Symbol('events.errorMonitor');
    EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
    EventEmitter.listenerCount = (emitter, n) => emitter.listenerCount(n);
    EventEmitter.getEventListeners = (emitter, n) => emitter.listeners(n);
    EventEmitter.setMaxListeners = (m, ...emitters) => { for (const e of emitters) e.setMaxListeners(m); };
    EventEmitter.once = (emitter, name) => new Promise((resolve, reject) => {
      const onEvent = (...args) => {
        emitter.removeListener('error', onError);
        resolve(args);
      };
      const onError = (err) => {
        emitter.removeListener(name, onEvent);
        reject(err);
      };
      emitter.once(name, onEvent);
      if (name !== 'error') emitter.once('error', onError);
    });
    /* events.on(emitter, name, options): the async iterator over an
     * emitter's events. Announced as a named export since the shim
     * landed, but never defined — `import { on } from "events"` bound
     * undefined. Events arriving faster than the consumer buffer in
     * `queue`; a consumer arriving first parks in `pending`. An 'error'
     * event (unless that IS the watched name) throws into the iterator,
     * `options.close` names events that end it, and `options.signal`
     * aborts it — Node's own three exits, plus `return()` for a `break`.
     * The C island drives this to completion; the Rust island has no
     * timer source, so a `for await` that outruns already-buffered
     * events parks forever there (ERR_MODULE_PROMISE_PENDING) — the
     * limit EventEmitter.once already carries on that lane. */
    EventEmitter.on = (emitter, name, options) => {
      const closes = options && options.close ? options.close : [];
      const queue = [];
      const pending = [];
      let failure = null;
      let done = false;
      const push = (...args) => {
        const next = pending.shift();
        if (next) next.resolve({ value: args, done: false });
        else queue.push(args);
      };
      const stop = () => {
        emitter.removeListener(name, push);
        if (name !== 'error') emitter.removeListener('error', fail);
        for (const close of closes) emitter.removeListener(close, finish);
      };
      const finish = () => {
        done = true;
        stop();
        const next = pending.shift();
        if (next) next.resolve({ value: undefined, done: true });
      };
      const fail = (err) => {
        const next = pending.shift();
        if (next) { done = true; stop(); next.reject(err); return; }
        failure = err;
        finish();
      };
      emitter.on(name, push);
      if (name !== 'error') emitter.on('error', fail);
      for (const close of closes) emitter.on(close, finish);
      if (options && options.signal) {
        options.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          e.code = 'ABORT_ERR';
          fail(e);
        });
      }
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
          if (failure !== null) { const err = failure; failure = null; return Promise.reject(err); }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
        },
        /* Node's own return() only detaches and resolves the parked
         * consumers — already-buffered events stay readable — so a
         * `break` here leaves the same observable state it does there. */
        return() {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(err) {
          failure = err;
          done = true;
          stop();
          return Promise.reject(err);
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.default = EventEmitter;
    return EventEmitter;
  });
