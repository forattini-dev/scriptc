import { createServer, request } from "node:http";

function outcome(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof Error) return `${error.name}:${(error as NodeJS.ErrnoException).code}:${error.message}`;
    return "unexpected error";
  }
}

const server = createServer((incoming, outgoing) => {
  console.log("wire", incoming.headers["x-initial"], incoming.headers["x-new"], incoming.headers["x-drop"] === undefined);
  outgoing.setHeader("X-First", "one");
  const names = outgoing.getHeaderNames();
  const snapshot = outgoing.getHeaders();
  outgoing.setHeader("x-first", "two");
  outgoing.setHeader("X-Drop", "gone");
  outgoing.removeHeader("x-drop");
  console.log("server names", names.join(","), outgoing.getHeaderNames().join(","), outgoing.getRawHeaderNames().join(","));
  console.log("server headers", JSON.stringify(snapshot), JSON.stringify(outgoing.getHeaders()), outgoing.getHeader("X-FIRST"));
  outgoing.end("done");
});

server.listen(0, () => {
  const port = server.address().port;
  const outbound = request({ hostname: "127.0.0.1", port, headers: { "X-Initial": "one" } }, (response) => {
    console.log("reply", response.statusCode, response.headers["x-first"]);
    response.on("data", () => {});
    response.on("end", () => server.close());
  });
  outbound.on("error", (error) => console.log("request error", error.message));
  const initial = outbound.getHeaders();
  const initialNames = outbound.getHeaderNames();
  console.log("client initial", initialNames.join(","), outbound.getRawHeaderNames().join(","), initial["x-initial"], outbound.getHeader("HOST") === `127.0.0.1:${port}`);
  outbound.setHeader("x-initial", "two");
  outbound.setHeader("X-Drop", "gone");
  outbound.setHeader("X-New", "yes");
  console.log("client changed", outbound.getHeader("X-INITIAL"), outbound.hasHeader("x-drop"), initial["x-initial"], outbound.getRawHeaderNames().join(","));
  outbound.removeHeader("x-drop");
  console.log("client removed", outbound.getHeader("X-Drop") === undefined, outbound.hasHeader("X-DROP"), JSON.stringify(outbound.getHeaderNames()));
  console.log("bad name", outcome(() => outbound.setHeader("bad name", "value")));
  console.log("bad value", outcome(() => outbound.setHeader("X-Bad", "line\nbreak")));
  outbound.flushHeaders();
  console.log("late set", outcome(() => outbound.setHeader("X-Late", "no")));
  console.log("late remove", outcome(() => outbound.removeHeader("X-New")));
  outbound.end();
});
