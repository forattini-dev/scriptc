    /* node:console — the Console class over any write streams plus
     * the global console (which the bootstrap upgrades below to
     * Node's format semantics for npm builds). */
  builtins.console = memo(() => {
    const format = (...a) => builtins.util().formatWithOptions({}, ...a);
    class Console {
      constructor(stdout, stderr) {
        const opts = stdout !== null && typeof stdout === 'object' && stdout.stdout !== undefined ? stdout : { stdout, stderr };
        this._out = opts.stdout;
        this._err = opts.stderr || opts.stdout;
        this._counts = new Map();
        this._times = new Map();
        for (const m of ['log', 'info', 'debug']) this[m] = (...a) => { this._out.write(format(...a) + '\n'); };
        for (const m of ['error', 'warn', 'trace']) this[m] = (...a) => { this._err.write((m === 'trace' ? 'Trace: ' : '') + format(...a) + '\n'); };
        this.dir = (obj, o) => { this._out.write(builtins.util().inspect(obj, { customInspect: false, ...o }) + '\n'); };
        this.assert = (v, ...a) => { if (!v) this.error('Assertion failed' + (a.length ? ': ' + format(...a) : '')); };
        this.count = (label) => { const l = label === undefined ? 'default' : String(label); const n = (this._counts.get(l) || 0) + 1; this._counts.set(l, n); this._out.write(l + ': ' + n + '\n'); };
        this.countReset = (label) => { this._counts.delete(label === undefined ? 'default' : String(label)); };
        this.time = (label) => { this._times.set(label === undefined ? 'default' : String(label), Date.now()); };
        this.timeEnd = (label) => { const l = label === undefined ? 'default' : String(label); const t = this._times.get(l); if (t !== undefined) { this._times.delete(l); this._out.write(l + ': ' + (Date.now() - t) + 'ms\n'); } };
        this.group = (...a) => { if (a.length) this.log(...a); };
        this.groupEnd = () => {};
        this.table = (data) => { this.log(data); };
        this.clear = () => {};
      }
    }
    const c = globalThis.console;
    c.Console = Console;
    c.default = c;
    return c;
  });
