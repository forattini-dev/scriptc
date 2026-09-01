    /* node:timers (+ timers/promises) over the island's timer
     * bridge; setImmediate rides a zero-delay timer (Node's check
     * phase does not exist here — documented divergence). */
  builtins.timers = memo(() => {
    const t = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setImmediate: globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
    };
    t.default = t;
    return t;
  });
  builtins['timers/promises'] = memo(() => {
    const delay = (ms, value, options) => new Promise((resolve, reject) => {
      const t = globalThis.setTimeout(() => resolve(value), ms);
      if (options !== undefined && options !== null && options.signal !== undefined && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', () => {
          globalThis.clearTimeout(t);
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          e.code = 'ABORT_ERR';
          reject(e);
        });
      }
    });
    const tp = {
      setTimeout: delay,
      setImmediate: (value) => delay(0, value),
      setInterval: (ms, value, options) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            await delay(ms, undefined, options);
            yield value;
          }
        },
      }),
      scheduler: { wait: (ms) => delay(ms), yield: () => delay(0) },
    };
    tp.default = tp;
    return tp;
  });
