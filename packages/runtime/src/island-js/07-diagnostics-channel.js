  builtins.diagnostics_channel = memo(() => {
    /* Real pub/sub semantics for plain channels (publish with no
     * subscribers is a no-op, matching Node); tracingChannel reports
     * hasSubscribers=false and its trace* methods run the traced function
     * without publishing lifecycle events — the AI SDK checks
     * hasSubscribers and skips tracing, exactly the Node path when nothing
     * subscribed. */
    const channels = Object.create(null);
    class Channel {
      constructor(name) { this.name = name; this._subs = []; }
      get hasSubscribers() { return this._subs.length > 0; }
      subscribe(fn) { this._subs.push(fn); }
      unsubscribe(fn) {
        const i = this._subs.indexOf(fn);
        if (i < 0) return false;
        this._subs.splice(i, 1);
        return true;
      }
      publish(msg) { for (const f of this._subs.slice()) f(msg, this.name); }
    }
    const channel = (name) => channels[name] || (channels[name] = new Channel(name));
    const tracingChannel = (name) => ({
      get hasSubscribers() {
        if (typeof name !== 'string') return false;
        for (const s of ['start', 'end', 'asyncStart', 'asyncEnd', 'error']) {
          if (channel('tracing:' + name + ':' + s).hasSubscribers) return true;
        }
        return false;
      },
      traceSync(fn, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
      tracePromise(fn, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
      traceCallback(fn, position, ctx, thisArg, ...args) { return fn.apply(thisArg, args); },
    });
    const dc = {
      channel,
      subscribe: (name, fn) => { channel(name).subscribe(fn); },
      unsubscribe: (name, fn) => channel(name).unsubscribe(fn),
      hasSubscribers: (name) => channel(name).hasSubscribers,
      tracingChannel,
    };
    dc.default = dc;
    return dc;
  });
