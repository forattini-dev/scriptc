import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((_request, response) => {
  response.writeEarlyHints({ "X-Ignored": "no link" });
  try {
    response.writeEarlyHints({ link: "" });
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("empty link", caught.name, caught.code, caught.message);
  }
  response.writeContinue();
  response.writeProcessing();

  try {
    response.writeEarlyHints({ link: "bad" });
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("bad link", caught.name, caught.code, caught.message);
  }
  try {
    response.writeEarlyHints({ link: "</good.css>; rel=preload", "Bad Name": "value" });
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("bad name", caught.name, caught.code, caught.message);
  }
  try {
    response.writeEarlyHints({ link: "</good.css>; rel=preload", "X-Bad": "bad\rvalue" });
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("bad value", caught.name, caught.code, caught.message);
  }

  const hints: Record<string, string> = {
    "X-Before": "first",
    link: "</main.css>; rel=preload; as=style",
    "X-After": "last",
  };
  response.writeEarlyHints(hints);
  console.log("final state", response.headersSent, response.writableEnded);
  response.end("ok");
});

server.listen(0, () => {
  const socket = connect(server.address().port, "127.0.0.1");
  let wire = "";
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  socket.on("data", (chunk: Buffer) => { wire += chunk.toString("utf8"); });
  socket.on("end", () => {
    const parts = wire.split("\r\n\r\n");
    for (let i = 0; i < parts.length - 1; i++) {
      console.log("head", parts[i]!.split("\r\n")[0]);
    }
    console.log("hints", parts[2]!.split("\r\n").slice(1).join("|"));
    console.log("body", parts[parts.length - 1]);
    server.close();
  });
});
