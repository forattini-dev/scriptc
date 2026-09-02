// A Fetch Response body is single-use; a second native consumer rejects
// with a TypeError instead of resolving with an empty body.
import * as http from "node:http";

const server = http.createServer((_request, response) => {
  response.end("accepted");
});

async function consumeTwice(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/body`);
  console.log(await response.text());
  try {
    await response.text();
    console.log("resolved twice");
  } catch (error) {
    console.log(error instanceof TypeError);
  }
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void consumeTwice(server.address().port);
});
