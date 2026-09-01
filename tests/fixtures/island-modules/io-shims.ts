// @dynamic
// A CommonJS package driving the island's I/O builtin shims - fs, fs/promises,
// crypto, zlib and os - over the Rust host bridge. Every value is
// deterministic, so the island's stdout must equal Node's byte for byte.
import { promised, report } from "iozoo";

console.log(`${report()}`);
// The value crosses the island boundary as a dynamic value, so the handler's
// parameter is `any` and the log has to be wrapped to stay a string.
promised().then((lines: any) => {
  console.log(`${lines}`);
});
