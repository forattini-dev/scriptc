// RequestInit method and body cross the static Fetch boundary into the native
// HTTP client; the local server observes the actual wire request.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk.toString("utf8");
  });
  request.on("end", () => {
    console.log(request.method, request.url, body);
    response.end("accepted");
  });
});

async function send(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    body: "agent payload",
  });
  console.log(await response.text());
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void send(server.address().port);
});
