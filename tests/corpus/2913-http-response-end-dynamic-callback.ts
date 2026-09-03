import * as http from "node:http";
import * as net from "node:net";

function endDynamic(response: http.ServerResponse, value: any): void {
  response.end(value);
}

let callbackCalled = false;
const server = http.createServer((_request, response) => {
  endDynamic(response, () => {
    callbackCalled = true;
  });
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.end("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });
  client.on("data", () => {});
  client.on("end", () => server.close());
});

server.on("close", () => console.log("callback:", callbackCalled));
