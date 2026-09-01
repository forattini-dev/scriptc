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
    EventEmitter.EventEmitter = EventEmitter;
    EventEmitter.default = EventEmitter;
    return EventEmitter;
  });
