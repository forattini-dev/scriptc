// The island module (Proxy has no static lowering): a Node-style
// `(err, result, out)` callback API and an Error-taking callback.
const seen = new Proxy({ calls: 0 }, {});
export function parse(cb: (err: Error | undefined, argv: unknown, out: string) => void): number {
  cb(undefined, { mode: "local" }, "parsed");
  cb(new TypeError("bad flag"), null, "");
  (seen as { calls: number }).calls += 2;
  return (seen as { calls: number }).calls;
}
export function withPlain(cb: (e: Error) => string): string {
  return cb(new RangeError("out of range"));
}
