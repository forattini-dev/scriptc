import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.url === "/quit") {
    res.end("bye");
    server.close(() => console.log("server closed"));
    return;
  }
  console.log(`start ${req.url} raw=${req.rawTrailers.length} note=${req.trailers["x-note"] === undefined ? "absent" : "present"}`);
  if (req.url === "/early") {
    res.end("early");
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  req.on("end", () => {
    if (req.url === "/incoming") {
      const head = req.headersDistinct["x-head"];
      const notes = req.trailersDistinct["x-note"];
      const auth = req.trailersDistinct.authorization;
      const note = req.trailers["x-note"];
      const cookie = req.trailers.cookie;
      const authorization = req.trailers.authorization;
      console.log(`incoming body=${body} head=${head === undefined ? "-" : head.join("|")} note=${note === undefined ? "-" : note} cookie=${cookie === undefined ? "-" : cookie} auth=${authorization === undefined ? "-" : authorization}`);
      console.log(`distinct notes=${notes === undefined ? "-" : notes.join("|")} auth=${auth === undefined ? "-" : auth.join("|")} raw=${req.rawTrailers.join("|")}`);
      res.setHeader("Trailer", "X-Reply");
      res.write("a");
      res.addTrailers({ "X-Reply": "done" });
      res.end("b");
      return;
    }
    if (req.url === "/fixed") {
      res.setHeader("Content-Length", "2");
      res.addTrailers({ "X-Ignored": "hidden" });
      res.end("ok");
      return;
    }
    if (req.url === "/replace") {
      res.setHeader("Trailer", "X-New");
      res.write("a");
      res.addTrailers({ "X-Old": "stale" });
      res.addTrailers({ "X-New": "fresh" });
      res.end();
      return;
    }
    if (req.url === "/explicit") {
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Trailer", "X-Explicit");
      res.addTrailers({ "X-Explicit": "yes" });
      res.end("ok");
      return;
    }
    if (req.url === "/declared") {
      res.setHeader("Trailer", "X-Later");
      res.addTrailers({ "X-Later": "yes" });
      res.end("ok");
      return;
    }
    if (req.url === "/invalid-framing") {
      res.setHeader("Trailer", "X-Later");
      res.setHeader("Content-Length", "2");
      try {
        res.end("no");
      } catch (err) {
        console.log(`invalid framing: ${err instanceof Error ? (err as Error).message : "?"}`);
        res.removeHeader("Content-Length");
        res.addTrailers({ "X-Later": "yes" });
        res.end("ok");
      }
      return;
    }
    try {
      res.addTrailers({ "Bad Name": "bad" });
    } catch (err) {
      console.log(`invalid name: ${err instanceof TypeError ? (err as Error).message : "?"}`);
    }
    try {
      res.addTrailers({ "X-Bad": "bad\nvalue" });
    } catch (err) {
      console.log(`invalid value: ${err instanceof TypeError ? (err as Error).message : "?"}`);
    }
    try {
      res.addTrailers({ "X\u0000Bad": "bad" });
    } catch (err) {
      console.log(`invalid NUL name: ${err instanceof TypeError}`);
    }
    try {
      res.addTrailers({ "X-Nul": "bad\u0000value" });
    } catch (err) {
      console.log(`invalid NUL value: ${err instanceof TypeError}`);
    }
    res.setHeader("Trailer", "X-Pair, X-Other");
    res.flushHeaders();
    res.addTrailers([["X-Pair", "one"], ["X-Other", "two"]]);
    res.end("ok");
  });
  req.resume();
});

server.listen(0, () => {
  console.log("listening");
  process.stderr.write(`PORT ${server.address().port}\n`);
});
