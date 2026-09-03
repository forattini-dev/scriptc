import * as http from "node:http";
import * as net from "node:net";

function endDynamic(response: http.ServerResponse, chunk: any): void {
  response.end(chunk, () => console.log("finished"));
}

const server = http.createServer((_request, response) => {
  endDynamic(response, undefined);
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });
  let raw = "";
  client.on("data", (chunk) => {
    raw += chunk.toString("utf8");
  });
  client.on("end", () => {
    console.log("body:", JSON.stringify(raw.slice(raw.indexOf("\r\n\r\n") + 4)));
    server.close();
  });
});
