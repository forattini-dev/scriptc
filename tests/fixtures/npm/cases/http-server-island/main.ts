// @dynamic
// The island serving REAL HTTP traffic: srvzoo's http.createServer runs
// inside the engine, the listening socket is the compiled runtime's, and
// the self-request rides the island's own http client back through it.
// This is express's app.listen() shape reduced to one vendorable package.
import { report } from "srvzoo";

report((text: string) => {
  console.log(text);
});
