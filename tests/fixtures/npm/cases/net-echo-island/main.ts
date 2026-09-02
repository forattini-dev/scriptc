// @dynamic
// The island driving REAL TCP: netzoo's echo server and its client both
// run inside the engine, on the compiled runtime's own sockets and the
// one native event loop. node:http's server leg is built on exactly this.
import { report } from "netzoo";

report((text: string) => {
  console.log(text);
});
