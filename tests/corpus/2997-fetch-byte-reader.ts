// Binary request/response bodies must retain non-UTF8 bytes across Fetch.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  request.on("data", (chunk) => response.write(chunk));
  request.on("end", () => response.end());
});

async function send(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: "POST", body: new Uint8Array([0, 255, 128, 65]), redirect: "manual",
  });
  const body = response.body!;
  console.log(body.locked, response.bodyUsed, body === response.body);
  const reader = body.getReader();
  console.log(body.locked, response.bodyUsed);
  const values: number[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    for (let i = 0; i < chunk.value.length; i++) values.push(chunk.value[i]);
  }
  console.log(values.join(","), response.bodyUsed, (await reader.read()).done);
  reader.releaseLock();
  console.log(body.locked);
  server.close();
}

server.listen(0, "127.0.0.1", () => { void send(server.address().port); });
