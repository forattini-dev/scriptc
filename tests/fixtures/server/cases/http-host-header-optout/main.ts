import { createServer } from "node:http";

const server = createServer({ requireHostHeader: false }, (req, res) => {
  console.log("handler " + req.url);
  res.end("ok");
  if (req.url === "/quit") server.close(() => console.log("closed"));
});

server.listen(0, () => {
  process.stderr.write("PORT " + server.address().port + "\n");
});
