import * as http from "node:http";

const server = http.createServer((_request, response) => {
  const headers: string[] = ["x-pair", "one", "x-other", "two"];
  response.writeHead(201, headers);
  response.end();
});

server.listen(0, "127.0.0.1", () => {
  http.get({ host: "127.0.0.1", port: server.address().port }, (response) => {
    console.log(response.statusCode, response.headers["x-pair"], response.headers["x-other"]);
    response.resume();
    response.on("end", () => server.close());
  });
});
