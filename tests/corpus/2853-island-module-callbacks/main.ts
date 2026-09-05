// @dynamic
// @island-module: ./events.ts
// Callbacks crossing INTO an island module: a typed callback over
// primitives (the host bridge spells it), and a callback whose parameter
// is an object the island owns (the checked-dynamic bridge: the callback
// receives handles, calls through them, and answers a primitive), plus
// a callback answering a record.
import { emit, withApi, describeVia, withDisposer } from "./events.ts";

console.log(emit(3, (n) => n * 2));
console.log(withApi((api) => api.inc() + api.inc() + api.label().length));
console.log(describeVia((name) => ({ name, upper: name.toUpperCase() })));
// A callback whose parameter is a function the island owns: arity crosses
// with the callback, and typeof on the handle asks the engine.
console.log(withDisposer((dispose) => {
  console.log(typeof dispose, typeof withDisposer);
  dispose();
}));
console.log(withDisposer(() => {}));
