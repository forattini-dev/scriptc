    /* node:domain — the deprecated legacy module, shimmed because
     * @sentry/node (inside a real CLI's graph) REQUIRES it at load
     * on every path (async/domain.js's top level) while only DRIVING it
     * on Node < 14, which never happens here. The shim keeps the module
     * loadable with the real synchronous surface: create()/Domain,
     * enter/exit maintaining the active stack, run/bind/intercept
     * catching sync throws into 'error' listeners (re-thrown when nobody
     * listens, Node's fatal path). Async error TRAPPING does not
     * propagate (no async_hooks machinery) — the documented limit of the
     * island's domain, same family as the async_hooks shim above. */
  builtins.domain = memo(() => {
    const EventEmitter = builtins.events();
    const stack = [];
    const d = { _stack: stack, active: null };
    class Domain extends EventEmitter {
      constructor() { super(); this.members = []; }
      enter() { stack.push(this); d.active = this; }
      exit() {
        const i = stack.lastIndexOf(this);
        if (i === -1) return;
        stack.splice(i);
        d.active = stack.length > 0 ? stack[stack.length - 1] : null;
      }
    /* run/bind do NOT catch: Node's sync throws propagate to the caller
     * (the domain traps only errors that reach the fatal/async layers —
     * machinery the island does not carry). And they exit the domain only
     * on the NON-throw path — Node's own bind runs enter → cb → exit with
     * no finally, so a throw leaves the domain ENTERED (oracle-pinned:
     * domain.active stays the domain after a throwing run). intercept's
     * error arm is the one documented emit path: decorate and emit
     * 'error' (an unhandled 'error' throws through the EventEmitter
     * contract, like Node). */
      run(fn, ...args) {
        this.enter();
        const ret = fn.apply(this, args);
        this.exit();
        return ret;
      }
      add(ee) { if (this.members.indexOf(ee) === -1) this.members.push(ee); if (ee) ee.domain = this; }
      remove(ee) { const i = this.members.indexOf(ee); if (i !== -1) this.members.splice(i, 1); if (ee && ee.domain === this) ee.domain = undefined; }
      bind(cb) {
        const self = this;
        function bound(...args) {
          self.enter();
          const ret = cb.apply(this, args);
          self.exit();
          return ret;
        }
        bound.domain = this;
        return bound;
      }
      intercept(cb) {
        const self = this;
        return this.bind(function intercepted(err, ...rest) {
          if (err) {
            if (typeof err === 'object' && err !== null) { err.domain = self; err.domainThrown = false; }
            self.emit('error', err);
            return undefined;
          }
          return cb.apply(this, rest);
        });
      }
      dispose() { this.exit(); this.removeAllListeners(); return this; }
    }
    const create = () => new Domain();
    d.Domain = Domain;
    d.create = create;
    d.createDomain = create;
    d.default = d;
    return d;
  });
