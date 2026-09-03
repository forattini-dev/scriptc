import * as net from "node:net";

function endDynamic(socket: net.Socket, chunk: any): void {
  socket.end(chunk);
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
  const first = net.connect(server.address().port, "127.0.0.1", () => {
    endDynamic(first, "alpha");
  });
  first.on("close", () => {
    const second = net.connect(server.address().port, "127.0.0.1", () => {
      endDynamic(second, Buffer.from("beta"));
    });
    second.on("close", () => server.close());
  });
});
