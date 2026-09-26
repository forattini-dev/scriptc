import { createServer, get } from "node:http";

let sendLate = () => {};
const server = createServer((_request, response) => {
  let sent = false;
  const finish = () => {
    if (sent) return;
    sent = true;
    response.end("late");
  };
  const fallback = setTimeout(finish, 2000);
  sendLate = () => { clearTimeout(fallback); finish(); };
  response.flushHeaders();
});

server.listen(0, () => {
  get({ port: server.address().port }, (response) => {
    response.setTimeout(15, () => {
      console.log("timed out", response.complete);
      sendLate();
    });
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      console.log("body", body, response.complete);
      server.close();
    });
  });
});
