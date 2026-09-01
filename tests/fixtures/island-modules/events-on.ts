// @dynamic
// `events.on`, the async iterator over an emitter's events. The island's
// builtin export table has always announced `on` as a named export of
// node:events, but the shim never defined it, so the name bound
// undefined and only failed at the call. Every event here is emitted
// before the loop starts, so the iterator drains its own buffer and needs
// no timer source — which is what lets the Rust island run it too.
import { probeEventsOn } from "shimuser";

probeEventsOn().then((line: any) => {
  console.log(`${line}`);
});
