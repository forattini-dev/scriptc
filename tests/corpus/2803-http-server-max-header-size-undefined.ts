import * as http from "node:http";

// Explicit undefined is the same as omitting maxHeaderSize. The server is
// usable and retains Node's default parser limit.
const server = http.createServer({ maxHeaderSize: undefined });
server.listen(0, "127.0.0.1", () => {
  console.log("listening");
  server.close();
});
