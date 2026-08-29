interface InputStream {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

interface ReadOptions {
  readonly stream?: InputStream;
}

interface HostIO {
  readonly read?: (options?: ReadOptions) => string;
}

function describe(io: HostIO = {}): string {
  return io.read === undefined ? "absent" : "present";
}

console.log(describe({}));
