import { createServer } from "node:net";

const server = createServer();
server.listen({ port: 0 }, () => {
  console.log("listening", server.address().port > 0);
  server.close();
});
