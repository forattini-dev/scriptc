// @dynamic
// `o.m?.()` on an island receiver: the present method calls with
// `this = o`, the absent one answers undefined without calling.
import { armed, idle } from "classzoo";

console.log(`${armed.ready?.()}:${idle.ready?.()}`);
