import * as http from "node:http";

let sendLate = () => {};
const server = http.createServer((_incoming, outgoing) => {
  let sent = false;
  const finish = () => {
    if (sent) return;
    sent = true;
    outgoing.end("late");
  };
  const fallback = setTimeout(finish, 2000);
  sendLate = () => { clearTimeout(fallback); finish(); };
});

server.listen(0, "127.0.0.1", () => {
  const client = http.request({ host: "127.0.0.1", port: server.address().port }, (response) => {
    console.log("response", response.statusCode);
    response.on("data", (chunk) => console.log("body", chunk.toString()));
    response.on("end", () => server.close());
  });
  client.setSocketKeepAlive(false);
  client.setSocketKeepAlive(true, 1000);
  client.setSocketKeepAlive();
  console.log("destroyed initially", client.destroyed);
  client.on("close", () => console.log("destroyed on close", client.destroyed));
  client.setTimeout(1000);
  console.log("same request", client.setTimeout(20, () => {
    console.log("timeout");
    sendLate();
  }) === client);
  client.end();
});
