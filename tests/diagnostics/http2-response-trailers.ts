import { createServer } from "node:http2";

createServer((_req, res) => {
  res.addTrailers({ "X-Later": "x" });
  res.end("ok");
});
