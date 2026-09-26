import { createServer, request } from "node:http";

const server = createServer((req, res) => {
  res.statusCode = 418;
  res.end(req.method + " " + req.url);
});
server.listen(0, () => {
  const outbound = request({ port: server.address().port, path: "/controls", method: "POST" }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log("reply", response.statusCode, response.statusMessage, body, outbound.finished, outbound.reusedSocket);
      server.close();
    });
  });
  console.log("initial", outbound.finished, outbound.reusedSocket);
  outbound.setNoDelay(false);
  outbound.setNoDelay();
  outbound.end();
  console.log("ended", outbound.finished, outbound.reusedSocket);
});
