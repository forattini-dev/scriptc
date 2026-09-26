import { createServer, request } from "node:http";

const server = createServer((incoming, outgoing) => {
  console.log("incoming", incoming.method, incoming.url, incoming.httpVersion);
  incoming.on("data", () => {});
  incoming.on("end", () => {
    console.log("incoming complete", incoming.complete);
    outgoing.end("done");
    console.log("response ended", outgoing.headersSent, outgoing.writableEnded);
  });
  console.log("response initial", outgoing.statusCode, outgoing.headersSent, outgoing.writableEnded);
  outgoing.setHeader("Content-Type", "text/plain");
  outgoing.flushHeaders();
  console.log("response flushed", outgoing.headersSent, outgoing.writableEnded);
});

console.log("server initial", server.listening);
server.listen(0, () => {
  console.log("server listening", server.listening);
  const port = server.address().port;
  const outbound = request({ hostname: "127.0.0.1", port, path: "/state?q=1", method: "POST" }, (incoming) => {
    console.log("reply", incoming.statusCode, incoming.httpVersion);
    incoming.on("data", () => {});
    incoming.on("end", () => {
      console.log("reply complete", incoming.complete);
      server.close(() => console.log("server closed", server.listening));
      console.log("server closing", server.listening);
    });
  });
  outbound.on("error", (error) => console.log("client error", error.message));
  console.log("client metadata", outbound.method, outbound.path, outbound.host, outbound.protocol);
  console.log("client initial", outbound.headersSent, outbound.writableEnded);
  outbound.flushHeaders();
  console.log("client flushed", outbound.headersSent, outbound.writableEnded);
  outbound.end("hi");
  console.log("client ended", outbound.headersSent, outbound.writableEnded);
});
