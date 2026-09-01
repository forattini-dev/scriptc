    /* tty.isatty over the same host hook process.stdout.isTTY answers
     * with; Node returns false for anything but a non-negative integer
     * fd (never throws), so the guard mirrors that before asking the
     * real isatty(3). */
  builtins.tty = memo(() => {
    const isatty = (fd) => Number.isInteger(fd) && fd >= 0 && host.isatty(fd);
    class ReadStream {
      constructor(fd) { this.fd = fd; this.isTTY = isatty(fd); this.isRaw = false; }
      setRawMode(mode) { this.isRaw = !!mode; return this; }
    }
    class WriteStream {
      constructor(fd) {
        this.fd = fd;
        this.isTTY = isatty(fd);
        const c = host.columns(fd);
        if (c > 0) this.columns = c;
      }
      write(s) { return host.write(this.fd, String(s)); }
      getColorDepth() { return this.isTTY ? 8 : 1; }
      hasColors(n) { return this.isTTY && (n === undefined || n <= 256); }
      getWindowSize() { return [this.columns || 0, 0]; }
      clearLine() { return true; }
      clearScreenDown() { return true; }
      cursorTo() { return true; }
      moveCursor() { return true; }
    }
    const tty = { isatty, ReadStream, WriteStream };
    tty.default = tty;
    return tty;
  });
