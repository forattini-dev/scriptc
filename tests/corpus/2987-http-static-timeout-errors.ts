import * as http from "node:http";

function result(action: () => void): string {
  try {
    action();
    return "ok";
  } catch (error) {
    if (error instanceof Error) return `${error.name}:${(error as NodeJS.ErrnoException).code}:${error.message}`;
    return "unexpected error";
  }
}

const server = http.createServer((incoming, outgoing) => {
  console.log("message negative", result(() => incoming.setTimeout(-1)));
  console.log("message infinite", result(() => incoming.setTimeout(Infinity, () => {})));
  incoming.resume();
  outgoing.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST" }, (response) => {
    response.resume();
    response.on("end", () => server.close());
  });
  console.log("client negative", result(() => client.setTimeout(-1)));
  console.log("client infinite", result(() => client.setTimeout(Infinity, () => {})));
  client.end("ping");
});
