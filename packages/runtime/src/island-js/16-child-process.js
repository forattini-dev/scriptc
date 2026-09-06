    /* node:child_process — the host's child bridge (Rust: the same async
     * child unit the static lane lowers to; the C island has no bridge and
     * keeps the does-not-provide throw). spawn/exec/execFile deliver
     * Node's ChildProcess: an EventEmitter with stdin/stdout/stderr
     * streams, pid, exitCode/signalCode, kill, ref/unref, and the
     * spawn/exit/close/error events in Node's order. The sync forms run
     * over the runtime's capture primitive (text output). */
  builtins.child_process = memo(() => {
    const EventEmitter = builtins.events().EventEmitter;
    const { Readable, Writable } = builtins.stream();
    const Buffer = builtins.buffer().Buffer;
    const nextTick = (fn) => queueMicrotask(fn);
    const unavailable = (name) => {
      throw new Error('child_process.' + name + ' is not available in the scriptc island');
    };
    const bridged = typeof host.childSpawn === 'function';
    const errnoOf = { ENOENT: -2, EACCES: -13, EPERM: -1, ENOTDIR: -20, EMFILE: -24, EAGAIN: -11, E2BIG: -7, EINVAL: -22 };
    const modeOf = (entry, fallback) => {
      if (entry === undefined || entry === null) return fallback;
      if (entry === 'pipe' || entry === 'overlapped') return 3;
      if (entry === 'ignore') return 0;
      if (entry === 'inherit') return 1;
      if (typeof entry === 'number') return entry === 0 || entry === 1 || entry === 2 ? 1 : 2;
      if (typeof entry === 'object' && typeof entry.fd === 'number') return 1;
      return 3;
    };
    const stdioOf = (stdio) => {
      if (stdio === undefined || stdio === null) return [3, 3, 3];
      if (typeof stdio === 'string') { const m = modeOf(stdio, 3); return [m, m, m]; }
      return [modeOf(stdio[0], 3), modeOf(stdio[1], 3), modeOf(stdio[2], 3)];
    };
    const envPairs = (env) => {
      if (env === undefined || env === null) return undefined;
      const pairs = [];
      for (const key of Object.keys(env)) {
        if (env[key] === undefined) continue;
        pairs.push(key, String(env[key]));
      }
      return pairs;
    };
    const shellCommand = (file, args, shell) => {
      if (!shell) return [file, args];
      const command = [file, ...args].join(' ');
      const sh = typeof shell === 'string' ? shell : '/bin/sh';
      return [sh, ['-c', command]];
    };
    class ChildProcess extends EventEmitter {
      constructor() {
        super();
        this._id = 0;
        this.pid = undefined;
        this.exitCode = null;
        this.signalCode = null;
        this.killed = false;
        this.connected = false;
        this.spawnfile = undefined;
        this.spawnargs = [];
        this.stdin = null;
        this.stdout = null;
        this.stderr = null;
        this.stdio = [null, null, null];
      }
      _spawn(file, args, options) {
        const [command, argv] = shellCommand(file, args, options.shell);
        this.spawnfile = command;
        this.spawnargs = [command, ...argv];
        const [stdinMode, stdoutMode, stderrMode] = stdioOf(options.stdio);
        const self = this;
        let openStreams = 0;
        const streamFor = (mode) => {
          if (mode !== 3) return null;
          openStreams++;
          const r = new Readable({ read() {} });
          return r;
        };
        this.stdout = streamFor(stdoutMode);
        this.stderr = streamFor(stderrMode);
        if (stdinMode === 3) {
          this.stdin = new Writable({
            write(chunk, encoding, cb) {
              const u8 = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
              host.childStdinWrite(self._id, u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
              cb();
            },
            final(cb) {
              host.childStdinEnd(self._id);
              cb();
            },
          });
          this.stdin.on('error', () => {});
        }
        this.stdio = [this.stdin, this.stdout, this.stderr];
        let exited = false;
        let exitArgs = null;
        const maybeClose = () => {
          if (exited && openStreams === 0) {
            const args = exitArgs;
            exitArgs = null;
            if (args) nextTick(() => self.emit('close', args[0], args[1]));
          }
        };
        const streamEnd = (stream) => {
          if (!stream) return;
          stream.push(null);
          openStreams--;
          maybeClose();
        };
        const callbacks = {
          onStdout: (chunk) => { if (self.stdout) self.stdout.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)); },
          onStdoutEnd: () => streamEnd(self.stdout),
          onStderr: (chunk) => { if (self.stderr) self.stderr.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)); },
          onStderrEnd: () => streamEnd(self.stderr),
          onExit: (code, signal) => {
            self.exitCode = code;
            self.signalCode = signal;
            exited = true;
            exitArgs = [code, signal];
            if (self.stdin && !self.stdin.destroyed) self.stdin.destroy();
            self.emit('exit', code, signal);
            maybeClose();
          },
          onClose: () => {},
          onError: (message, code) => {
            const err = new Error(message);
            err.code = code;
            err.errno = errnoOf[code] !== undefined ? errnoOf[code] : -1;
            err.syscall = 'spawn ' + command;
            err.path = command;
            err.spawnargs = argv;
            self.exitCode = err.errno;
            exited = true;
            exitArgs = [err.errno, null];
            if (self.stdout) { openStreams = 0; self.stdout.push(null); }
            if (self.stderr) { self.stderr.push(null); }
            if (self.stdin && !self.stdin.destroyed) self.stdin.destroy();
            self.emit('error', err);
            maybeClose();
          },
        };
        const [id, pid] = host.childSpawn(command, argv, {
          stdin: stdinMode, stdout: stdoutMode, stderr: stderrMode,
          cwd: options.cwd === undefined || options.cwd === null ? '' : String(options.cwd),
          env: envPairs(options.env),
          detached: options.detached ? 1 : 0,
        }, callbacks);
        this._id = id;
        if (pid !== null) {
          this.pid = pid;
          nextTick(() => self.emit('spawn'));
        }
        return this;
      }
      kill(signal) {
        if (signal === undefined) signal = 'SIGTERM';
        if (typeof signal === 'number') {
          const names = builtins.os().constants.signals;
          for (const name of Object.keys(names)) if (names[name] === signal) { signal = name; break; }
        }
        const sent = host.childKill(this._id, String(signal));
        if (sent) this.killed = true;
        return sent;
      }
      ref() { return this; }
      unref() { host.childUnref(this._id); return this; }
      disconnect() {}
      send() { throw new Error('child_process IPC channels are not available in the scriptc island'); }
      [Symbol.dispose]() { this.kill(); }
    }
    const normalizeSpawnArgs = (file, args, options) => {
      if (!Array.isArray(args)) { options = args; args = []; }
      return [String(file), args.map(String), options || {}];
    };
    const spawn = (file, args, options) => {
      if (!bridged) unavailable('spawn');
      const [f, a, o] = normalizeSpawnArgs(file, args, options);
      return new ChildProcess()._spawn(f, a, o);
    };
    const collect = (child, options, callback, commandLabel) => {
      const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
      const out = [], err = [];
      if (child.stdout) child.stdout.on('data', (c) => out.push(c));
      if (child.stderr) child.stderr.on('data', (c) => err.push(c));
      const decode = (chunks) => {
        const buf = Buffer.concat(chunks);
        return encoding === 'buffer' || encoding === null ? buf : buf.toString(encoding);
      };
      let settled = false;
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        if (callback) callback(e, decode(out), decode(err));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        let e = null;
        if (code !== 0) {
          e = new Error('Command failed: ' + commandLabel + (err.length ? '\n' + Buffer.concat(err).toString('utf8') : ''));
          e.code = code;
          e.killed = child.killed;
          e.signal = signal;
          e.cmd = commandLabel;
        }
        if (callback) callback(e, decode(out), decode(err));
      });
      if (child.stdin) child.stdin.end();
      return child;
    };
    const exec = (command, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};
      const child = spawn(command, [], { ...options, shell: options.shell === undefined ? true : options.shell });
      return collect(child, options, callback, String(command));
    };
    const execFile = (file, args, options, callback) => {
      if (typeof args === 'function') { callback = args; args = []; options = {}; }
      else if (!Array.isArray(args)) { callback = options; options = args; args = []; }
      if (typeof options === 'function') { callback = options; options = {}; }
      options = options || {};
      const child = spawn(file, args, options);
      return collect(child, options, callback, [file, ...args].join(' '));
    };
    const syncRun = (file, args, options, label, defaultStdio) => {
      if (!bridged) unavailable('spawnSync');
      const [command, argv] = shellCommand(file, args, options.shell);
      const [stdinMode, stdoutMode, stderrMode] = options.stdio === undefined ? defaultStdio : stdioOf(options.stdio);
      const [status, signal, stdout, stderr, message, code] = host.childSpawnSync(command, argv, {
        cwd: options.cwd === undefined || options.cwd === null ? '' : String(options.cwd),
        env: envPairs(options.env),
        timeout: options.timeout === undefined ? 0 : options.timeout,
        killSignal: options.killSignal === undefined ? '' : String(options.killSignal),
        stdin: stdinMode, stdout: stdoutMode, stderr: stderrMode,
      });
      const encoding = options.encoding === undefined ? 'buffer' : options.encoding;
      const wrap = (text) => (encoding === 'buffer' || encoding === null ? Buffer.from(text, 'utf8') : Buffer.from(text, 'utf8').toString(encoding));
      const result = {
        pid: 0,
        output: [null, wrap(stdout), wrap(stderr)],
        stdout: wrap(stdout),
        stderr: wrap(stderr),
        status,
        signal,
      };
      if (message !== null) {
        const e = new Error(message);
        e.code = code;
        e.errno = errnoOf[code] !== undefined ? errnoOf[code] : -1;
        e.syscall = 'spawnSync ' + command;
        e.path = command;
        e.spawnargs = argv;
        result.error = e;
      }
      return result;
    };
    const spawnSync = (file, args, options) => {
      const [f, a, o] = normalizeSpawnArgs(file, args, options);
      return syncRun(f, a, o, [f, ...a].join(' '), [3, 3, 3]);
    };
    const failure = (result, label) => {
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const stderrText = typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8');
        const e = new Error('Command failed: ' + label + (stderrText ? '\n' + stderrText : ''));
        e.status = result.status;
        e.signal = result.signal;
        e.output = result.output;
        e.pid = result.pid;
        e.stdout = result.stdout;
        e.stderr = result.stderr;
        throw e;
      }
    };
    const execSync = (command, options) => {
      options = options || {};
      // Node's execSync default: stdout captured, stderr inherited.
      const result = syncRun(String(command), [], { ...options, shell: options.shell === undefined ? true : options.shell }, String(command), [3, 3, 1]);
      failure(result, String(command));
      return result.stdout;
    };
    const execFileSync = (file, args, options) => {
      if (!Array.isArray(args)) { options = args; args = []; }
      options = options || {};
      const result = syncRun(String(file), args.map(String), options, [file, ...args].join(' '), [3, 3, 1]);
      failure(result, [file, ...args].join(' '));
      return result.stdout;
    };
    const fork = () => unavailable('fork');
    const cp = { ChildProcess, spawn, exec, execFile, spawnSync, execSync, execFileSync, fork, _forkChild: () => unavailable('_forkChild') };
    cp.default = cp;
    return cp;
  });
