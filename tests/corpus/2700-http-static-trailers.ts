import { createServer, request } from "node:http";

const server = createServer((incoming, outgoing) => {
  const early = incoming.trailers["x-note"];
  console.log(`early trailer=${early === undefined ? "absent" : early} raw=${incoming.rawTrailers.length}`);
  let body = "";
  incoming.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  incoming.on("end", () => {
    const trailer = incoming.trailers["x-note"];
    const snapshot = incoming.trailers;
    const values = incoming.trailersDistinct["x-note"];
    const hostValues = incoming.headersDistinct.host;
    console.log(`request body=${body} trailer=${trailer === undefined ? "absent" : trailer} snapshot=${snapshot["x-note"]} distinct=${values === undefined ? "absent" : values.join(",")} host-count=${hostValues === undefined ? 0 : hostValues.length} raw=${incoming.rawTrailers.join("|")}`);
    outgoing.setHeader("Trailer", "X-Reply");
    outgoing.flushHeaders();
    console.log(`response headersSent=${outgoing.headersSent}`);
    outgoing.cork();
    outgoing.write("a");
    outgoing.cork();
    outgoing.write("b");
    console.log(`response corked=${outgoing.writableCorked}`);
    outgoing.uncork();
    outgoing.uncork();
    console.log(`response uncorked=${outgoing.writableCorked}`);
    outgoing.addTrailers([["X-Reply", "done"]]);
    outgoing.end("c");
  });
});

server.listen(0, () => {
  const outbound = request({ port: server.address().port, method: "POST", headers: { Trailer: "X-Note", "Transfer-Encoding": "chunked" } }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      const value = response.trailers["x-reply"];
      const values = response.trailersDistinct["x-reply"];
      console.log(`response body=${body} trailer=${value === undefined ? "absent" : value} distinct=${values === undefined ? "absent" : values.join(",")} raw=${response.rawTrailers.join("|")}`);
      server.close();
    });
  });
  outbound.flushHeaders();
  outbound.write("hello");
  outbound.addTrailers({ "X-Note": "one" });
  outbound.end();
});
