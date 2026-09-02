// @dynamic
// Declared numeric package results remain island handles until read.
// Strict equality must compare their JavaScript number value, not wrappers.
import { readState } from "number-state";

console.log(readState().count === 2);
