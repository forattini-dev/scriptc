// @dynamic
// The island SERVING http: httpsrvzoo's http.createServer runs inside the
// engine, the listening socket is the compiled runtime's, and the probe
// is a raw island node:net client reading the wire back byte for byte.
import { report } from "httpsrvzoo";

report((text: string) => {
  console.log(text);
});
