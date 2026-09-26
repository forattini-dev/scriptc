// An https.Agent handle participates in the agent-aware TLS request path.
// The response listener is registered after request() so this fixture pins
// the non-callback requestAgent row independently from requestAgentCb.
import { readFileSync } from "node:fs";
import { Agent, createServer, request } from "node:https";

const server = createServer({
  key: readFileSync("tests/fixtures/server/certs/localhost-key.pem"),
  cert: readFileSync("tests/fixtures/server/certs/localhost.pem"),
}, (_incoming, response) => {
  response.end("agent tls");
});

server.listen(0, "127.0.0.1", () => {
  const client = request({
    hostname: "127.0.0.1",
    port: server.address().port,
    path: "/agent",
    rejectUnauthorized: false,
    agent: new Agent(),
  });
  client.once("response", (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("end", () => {
      console.log(response.statusCode, body);
      server.close();
    });
  });
  client.end();
});
