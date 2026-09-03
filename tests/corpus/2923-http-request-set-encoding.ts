import * as http from "node:http";

const server = http.createServer((request, response) => {
  request.setEncoding("utf8");
  request.on("data", (chunk) => console.log(typeof chunk, chunk));
  request.on("end", () => {
    response.end();
    server.close();
  });
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    method: "POST",
    headers: { "content-length": "3" },
  });
  request.end("hé");
});
