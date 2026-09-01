  builtins.process = memo(() => {
    const argv = host.argv();
    const stream = (fd) => {
      const s = { fd, write: (str) => host.write(fd, String(str)) };
      if (host.isatty(fd)) {
        s.isTTY = true;
        const c = host.columns(fd);
        if (c > 0) s.columns = c;
      }
    /* listener surface, accepted-and-inert (the epipebomb shape:
     * stream.on('error', ...) + stream.listeners('error') at module
     * evaluation) — island stdio writes are synchronous host writes, so
     * these events never fire; registration must still succeed. */
      s.on = () => s;
      s.once = () => s;
      s.addListener = () => s;
      s.off = () => s;
      s.removeListener = () => s;
      s.removeAllListeners = () => s;
      s.listeners = () => [];
      s.listenerCount = () => 0;
      s.emit = () => false;
      return s;
    };
    const p = {
      argv,
      env: host.env(),
      platform: host.platform(),
      execPath: argv[0],
      execArgv: [],
    /* the compat target's versions, same answers as the static world's
     * process.versions (scr_lib.c) */
      version: 'v' + host.versions()[0],
      versions: { node: host.versions()[0], openssl: host.versions()[1] },
      pid: host.pid(),
      ppid: 0,
      title: 'scriptc',
      argv0: 'scriptc',
      release: { name: 'node' },
      config: { variables: {} },
      allowedNodeEnvironmentFlags: new Set(),
      exitCode: undefined,
      stdout: stream(1),
      stderr: stream(2),
    /* stdin: a REAL Readable over a whole-input host read (the formatter idiom's
     * get-stdin async-iterates it when no file arguments arrive). The
     * host read happens lazily on the first pull — a program that only
     * probes isTTY or registers listeners never blocks on a silent pipe,
     * and get-stdin's isTTY early-return keeps interactive terminals
     * away from the read entirely. One chunk, then EOF: the island's
     * stdio is whole-value like its fs (no partial-read backpressure to
     * report). setRawMode stays accepted-and-inert — there is no raw
     * TTY bridge. */
      stdin: (() => {
        const { Readable } = builtins.stream();
        const Buffer = builtins.buffer().Buffer;
        let pulled = false;
        const s = new Readable({
          read() {
            if (pulled) return;
            pulled = true;
            const data = host.readStdin();
            if (data.byteLength > 0) this.push(Buffer.from(data));
            this.push(null);
          },
        });
        s.fd = 0;
    /* Node's process.stdin is a tty.ReadStream only when fd 0 IS a tty
     * — pipes get a socket with NO setRawMode, and packages probe with
     * `process.stdin.setRawMode?.()`. Mirror the shape, not a stub. */
        if (host.isatty(0)) { s.isTTY = true; s.setRawMode = () => s; }
        s.unref = () => s;
        s.ref = () => s;
        return s;
      })(),
      cwd: () => host.cwd(),
      exit: (code) => {
        host.exit(code === undefined || code === null ? Number(p.exitCode ?? 0) : Number(code));
      },
    /* Node's nextTick rides the island's microtask queue — ordering
     * against promise jobs is the engine's, not Node's dedicated
     * nextTick queue (divergence: documented in the shim report). */
      nextTick: (fn, ...args) => { queueMicrotask(() => fn(...args)); },
      hrtime: Object.assign(
        (prev) => {
          const now = host.hrtime();
          if (prev === undefined) return now;
          let sec = now[0] - prev[0];
          let ns = now[1] - prev[1];
          if (ns < 0) { sec -= 1; ns += 1e9; }
          return [sec, ns];
        },
        { bigint: () => { const t = host.hrtime(); return BigInt(t[0]) * 1000000000n + BigInt(t[1]); } },
      ),
      uptime: () => host.hrtime()[0],
    /* umask(): the read form only (Node's no-arg getter — make-dir and
     * friends call it at module evaluation for their mode defaults); the
     * setter form is a loud fence, not a silent lie. */
      umask: (mask) => {
        if (mask !== undefined) throw new Error('process.umask(mask) is not supported in the scriptc island (the read-only form works)');
        return host.umask();
      },
      memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
      emitWarning: (warning, type) => {
        const name = typeof type === 'string' ? type : 'Warning';
        const msg = warning instanceof Error ? warning.message : String(warning);
        host.write(2, '(node:' + host.pid() + ') ' + name + ': ' + msg + '\n');
      },
    /* listener surface, accepted-and-inert — the same shape the stdio
     * streams above carry. The QUERY forms matter as much as the
     * registration ones: depd asks `process.listenerCount('deprecation')`
     * (falling back to `process.listeners(type).length`) before every
     * deprecation it prints, so a missing pair throws "not a function"
     * out of an otherwise-harmless warning. */
      on: () => p,
      once: () => p,
      off: () => p,
      addListener: () => p,
      prependListener: () => p,
      prependOnceListener: () => p,
      removeListener: () => p,
      removeAllListeners: () => p,
      listeners: () => [],
      rawListeners: () => [],
      listenerCount: () => 0,
      eventNames: () => [],
      setMaxListeners: () => p,
      getMaxListeners: () => 10,
      emit: () => false,
    };
    /* process.exitCode is Node's IMPLICIT exit status: a program that
     * sets it and returns normally exits with it. The setter mirrors the
     * value into the C side (isl_exit_code), which the emitted main
     * returns after the loop drains — delete p.exitCode first so the
     * accessor pair replaces the literal's plain `undefined` slot. */
    delete p.exitCode;
    let exitCodeSlot;
    Object.defineProperty(p, 'exitCode', {
      enumerable: true,
      get: () => exitCodeSlot,
      set: (v) => {
        exitCodeSlot = v;
        const n = v === undefined || v === null ? 0 : Number(v);
        host.setExitCode(Number.isFinite(n) ? n : 0);
      },
    });
    p.default = p;
    return p;
  });
