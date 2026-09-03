import * as net from "node:net";

const server = net.createServer();
server.listen({ port: 0, host: "127.0.0.1" }, () => {
  const address = server.address();
  console.log(address.address, address.family, address.port > 0);
  server.close();
});
