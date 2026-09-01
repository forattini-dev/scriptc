// @dynamic
// A CommonJS package driving the island's pure builtin shims. Every value is
// deterministic, so the island's stdout must equal Node's byte for byte.
import { report } from "shimuser";

console.log(report());
