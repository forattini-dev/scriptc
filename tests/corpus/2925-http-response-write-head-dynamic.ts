import * as http from "node:http";

function send(response: http.ServerResponse, headers: any): void {
  response.writeHead(202, headers);
  response.end();
}

const server = http.createServer((_request, response) => {
  send(response, { "x-text": "yes", "x-number": 7 });
});

server.listen(0, "127.0.0.1", () => {
  http.get({ host: "127.0.0.1", port: server.address().port }, (response) => {
    console.log(response.statusCode, response.headers["x-text"], response.headers["x-number"]);
    response.resume();
    response.on("end", () => server.close());
  });
});
