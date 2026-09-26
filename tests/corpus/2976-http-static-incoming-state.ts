import { createServer, request } from "node:http";

const server = createServer((incoming, outgoing) => {
  outgoing.on("finish", () => { console.log("response finish", outgoing.finished); });
  outgoing.on("close", () => { console.log("response close", outgoing.finished); });
  const headers = incoming.headers;
  console.log("request", incoming.aborted, incoming.connection === incoming.socket, headers["x-test"], Object.keys(headers).includes("host"));
  incoming.setTimeout(500);
  let body = "";
  incoming.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  incoming.on("end", () => {
    console.log("request body", body, incoming.complete, incoming.aborted);
    outgoing.end("ok");
    console.log("response finished", outgoing.finished);
  });
  incoming.on("close", () => { console.log("request close", incoming.complete); });
});

server.listen(0, () => {
  const outbound = request({ port: server.address().port, method: "POST", headers: { "X-Test": "one" } }, (response) => {
    const headers = response.headers;
    console.log("reply", response.statusMessage, response.connection === response.socket, response.aborted, headers["content-length"]);
    response.setTimeout(500);
    response.on("close", () => { console.log("reply close", response.complete); });
    response.resume();
    response.on("end", () => { server.close(); });
  });
  outbound.end("ping");
});
