    /* node:readline — createInterface over any Readable-ish input
     * (data-event line splitting, question/line/close, async
     * iteration) and the cursor-control writers (the ANSI sequences
     * Node writes). Terminal echo/keypress machinery is inert. */
  builtins.readline = memo(() => {
    const EventEmitter = builtins.events();
    class Interface extends EventEmitter {
      constructor(input, output, completer, terminal) {
        super();
        let opts = input;
        if (!opts || typeof opts.on === 'function') opts = { input, output, completer, terminal };
        this.input = opts.input;
        this.output = opts.output;
        this.terminal = opts.terminal !== undefined ? !!opts.terminal : !!(this.output && this.output.isTTY);
        this._prompt = opts.prompt !== undefined ? opts.prompt : '> ';
        this._buf = '';
        this.closed = false;
        this.line = '';
        this.cursor = 0;
        this._onData = (chunk) => {
          this._buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          let i;
          while ((i = this._buf.indexOf('\n')) >= 0) {
            let line = this._buf.slice(0, i);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            this._buf = this._buf.slice(i + 1);
    /* a pending question consumes the line — Node's Interface answers
     * the question without emitting 'line' for that row */
            const q = this._questions && this._questions.shift();
            if (q !== undefined) q(line);
            else this.emit('line', line);
          }
        };
        this._onEnd = () => this.close();
        if (this.input && typeof this.input.on === 'function') {
          this.input.on('data', this._onData);
          this.input.on('end', this._onEnd);
        }
      }
      question(query, optionsOrCb, maybeCb) {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
        if (this.output && typeof this.output.write === 'function') this.output.write(String(query));
        if (typeof cb === 'function') {
          if (this._questions === undefined) this._questions = [];
          this._questions.push(cb);
        }
      }
      setPrompt(p) { this._prompt = String(p); }
      getPrompt() { return this._prompt; }
      prompt() {
        if (this.output && typeof this.output.write === 'function') this.output.write(this._prompt);
      }
      write(data) {
        if (data !== undefined && data !== null && this.output && typeof this.output.write === 'function') this.output.write(String(data));
      }
      pause() { if (this.input && this.input.pause) this.input.pause(); return this; }
      resume() { if (this.input && this.input.resume) this.input.resume(); return this; }
      close() {
        if (this.closed) return;
        this.closed = true;
        if (this.input && typeof this.input.removeListener === 'function') {
          this.input.removeListener('data', this._onData);
          this.input.removeListener('end', this._onEnd);
        }
        this.emit('close');
      }
      [Symbol.asyncIterator]() {
        const lines = [];
        let notify = null;
        let done = false;
        this.on('line', (l) => { lines.push(l); if (notify) { const n = notify; notify = null; n(); } });
        this.on('close', () => { done = true; if (notify) { const n = notify; notify = null; n(); } });
        return {
          next: async () => {
            while (lines.length === 0 && !done) await new Promise((res) => { notify = res; });
            if (lines.length > 0) return { value: lines.shift(), done: false };
            return { value: undefined, done: true };
          },
          [Symbol.asyncIterator]() { return this; },
        };
      }
    }
    const wr = (stream, s, cb) => {
      if (stream && typeof stream.write === 'function') stream.write(s);
      if (typeof cb === 'function') queueMicrotask(cb);
      return true;
    };
    const rl = {
      Interface,
      createInterface: (input, output, completer, terminal) => new Interface(input, output, completer, terminal),
      clearLine: (stream, dir, cb) => wr(stream, dir < 0 ? '\u001b[1K' : dir > 0 ? '\u001b[0K' : '\u001b[2K', cb),
      clearScreenDown: (stream, cb) => wr(stream, '\u001b[0J', cb),
      cursorTo: (stream, x, y, cb) => {
        if (typeof y === 'function') { cb = y; y = undefined; }
        return wr(stream, y === undefined ? '\u001b[' + (x + 1) + 'G' : '\u001b[' + (y + 1) + ';' + (x + 1) + 'H', cb);
      },
      moveCursor: (stream, dx, dy, cb) => {
        let s = '';
        if (dx < 0) s += '\u001b[' + (-dx) + 'D'; else if (dx > 0) s += '\u001b[' + dx + 'C';
        if (dy < 0) s += '\u001b[' + (-dy) + 'A'; else if (dy > 0) s += '\u001b[' + dy + 'B';
        return wr(stream, s, cb);
      },
      emitKeypressEvents: () => {},
    };
    rl.default = rl;
    return rl;
  });
