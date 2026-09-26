import { createServer, get } from "node:http";

const server = createServer((req, res) => {
  console.log("paired", res.req.method, res.req.url);
  console.log("defaults", res.sendDate, res.strictContentLength, res.statusMessage === undefined, res.writableFinished);
  const socket = res.socket;
  console.log("socket", socket !== null, res.connection !== null, socket !== null && socket.remoteAddress === req.socket.remoteAddress);
  if (req.url === "/no-date") {
    res.sendDate = false;
    res.strictContentLength = true;
    res.setHeader("Content-Length", "2");
    console.log("configured", res.sendDate, res.strictContentLength);
    res.setTimeout(1000).end("ok", () => {
      console.log("finished", res.statusMessage, res.writableFinished, res.socket === null, res.connection === null);
    });
    console.log("after end", res.statusMessage, res.writableFinished, res.socket !== null);
    return;
  }
  if (req.url === "/recover") {
    res.strictContentLength = true;
    res.setHeader("Content-Length", "2");
    try {
      res.end("a");
    } catch (error) {
      if (error instanceof Error) {
        console.log("mismatch", (error as NodeJS.ErrnoException).code, error.message);
      }
      res.end("a");
    }
    return;
  }
  if (req.url === "/overflow") {
    res.strictContentLength = true;
    res.setHeader("Content-Length", "2");
    res.write("a");
    try {
      res.write("bc");
    } catch (error) {
      if (error instanceof Error) {
        console.log("overflow", (error as NodeJS.ErrnoException).code, error.message);
      }
    }
    res.end("d");
    return;
  }
  if (req.url === "/unicode") {
    res.strictContentLength = true;
    res.setHeader("Content-Length", "3");
    res.end("é!");
    return;
  }
  res.setTimeout(25, () => {
    console.log("response timeout");
    res.end("late");
  });
});

server.listen(0, () => {
  const port = server.address().port;
  const paths = ["/no-date", "/recover", "/overflow", "/unicode", "/slow"];
  const visit = (index: number): void => {
    if (index === paths.length) {
      server.close(() => console.log("closed"));
      return;
    }
    const path = paths[index]!;
    get({ hostname: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => {
        console.log("reply", path, response.statusCode, response.headers.date !== undefined, body);
        visit(index + 1);
      });
    }).on("error", (error) => console.log("client error", error.message));
  };
  visit(0);
});
