import * as net from "node:net";

function writeDynamic(socket: net.Socket, chunk: any): void {
  socket.write(chunk);
}

const server = net.createServer((socket) => {
  let body = "";
  socket.on("data", (chunk) => {
    body += chunk.toString();
  });
  socket.on("end", () => {
    console.log(body);
    socket.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    writeDynamic(client, "alpha");
    writeDynamic(client, Buffer.from("beta"));
    client.end();
  });
  client.on("close", () => server.close());
});
