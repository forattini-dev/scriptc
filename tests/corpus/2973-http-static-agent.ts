import { Agent, createServer, request } from "node:http";

const agent = new Agent({ maxSockets: 1 });
console.log("agent defaults", agent.getName(), agent.maxSockets, agent.maxFreeSockets, agent.keepAlive, agent.protocol);
console.log("agent name", agent.getName({ host: "example.test", port: 8080, family: 4 }));

const server = createServer((req, res) => { res.end(req.url); });
server.listen(0, () => {
  const port = server.address().port;
  const name = agent.getName({ host: "127.0.0.1", port });
  const outbound = request({ hostname: "127.0.0.1", port, path: "/agent", agent }, (response) => {
    console.log("agent tables", agent.sockets[name].length, name in agent.requests, Object.keys(agent.freeSockets).length);
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log("response", response.statusCode, body, agent.totalSocketCount);
      agent.destroy();
      server.close();
    });
  });
  outbound.end();
});
