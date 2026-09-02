// @dynamic
// A dyn-BOXED island-rest closure called through the dyn boundary. The
// `...args` binding must be the ENGINE's own array on every path that
// reaches the closure — the direct call, a closure entering the island as
// a host function, and (this program) the boxed call thunk.
//
// A module-level `const f = (...args) =>` in a .js program is stored as a
// dyn global, so `f(1, 2)` routes through that thunk. The thunk used to
// fill the signature's trailing jsval slot POSITIONALLY, handing the
// closure the first surplus argument where it expects the pack — so
// `args.length` read a number's missing property — and then passed an
// extra dyn array the callee has no parameter for.
"use strict";

const rest = (...args) => `${args.length}:${args.join(",")}`;
console.log(rest());
console.log(rest(1));
console.log(rest(1, 2, 3));

// Leading declared params keep filling positionally; the pack is the tail
// only, and a short call pads the declared slots with undefined.
const lead = (a, b, ...args) => `${a}|${b}|${args.length}:${args.join(",")}`;
console.log(lead(1, 2));
console.log(lead(1, 2, 3, 4));
console.log(lead(1));

// A composite surplus argument crosses the boundary as an engine value.
const first = (...args) => args[0];
console.log(JSON.stringify(first({ x: 1 })));

console.log("done");
