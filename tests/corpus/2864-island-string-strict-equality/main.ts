// @dynamic
// Optional strings returned by packages retain their island representation.
// Strict equality still compares JavaScript string contents across the bridge.
import { readState } from "string-state";

console.log(readState().mode === "ready");
