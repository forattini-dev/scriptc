export function emit(n: number, cb: (x: number) => number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) total += cb(i);
  return total;
}

export interface Api {
  inc(): number;
  label(): string;
}

export function withApi(cb: (api: Api) => number): number {
  let count = 0;
  const api: Api = {
    inc() {
      count += 1;
      return count;
    },
    label() {
      return `count=${count}`;
    },
  };
  return cb(api) * 10;
}

export function describeVia(cb: (name: string) => { name: string; upper: string }): string {
  const d = cb("island");
  return `${d.name}/${d.upper}`;
}

let disposed = 0;
export function withDisposer(cb: (dispose: () => void) => void): number {
  // Libraries branch on the callback's arity (solid's createRoot only
  // hands a disposer to callbacks that declare one).
  if (cb.length === 0) return -1;
  cb(() => {
    disposed += 1;
  });
  return disposed;
}
