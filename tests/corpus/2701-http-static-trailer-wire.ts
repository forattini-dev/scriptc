import * as http from "node:http";
import * as net from "node:net";

const server = net.createServer((socket) => {
  let wire = "";
  let answered = false;
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString("utf8");
    if (!answered && wire.includes("\r\n0\r\nX-Sent: yes\r\n\r\n")) {
      answered = true;
      const split = wire.indexOf("\r\n\r\n");
      const head = wire.slice(0, split);
      const body = wire.slice(split + 4);
      console.log(`request chunked=${head.includes("Transfer-Encoding: chunked")} trailer-declared=${head.includes("Trailer: X-Sent")} body=${body.split("\r\n").join("|")}`);
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
        "Connection: close\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Trailer: X-Reply, Cookie, Authorization\r\n" +
        "X-Head: one\r\n" +
        "X-Head: two\r\n\r\n" +
        "2\r\nok\r\n0\r\n" +
        "X-Reply: first\r\nx-reply: second\r\n" +
        "Cookie: a=1\r\nCookie: b=2\r\n" +
        "Authorization: one\r\nAuthorization: two\r\n\r\n",
      );
    }
  });
});

server.listen(0, () => {
  const outbound = http.request({ port: server.address().port, method: "POST", headers: { Trailer: "X-Sent" } }, (response) => {
    console.log(`early response raw=${response.rawTrailers.length} trailer=${response.trailers["x-reply"] === undefined ? "absent" : "present"}`);
    const heads = response.headersDistinct["x-head"];
    let body = "";
    response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    response.on("end", () => {
      const reply = response.trailers["x-reply"];
      const cookie = response.trailers.cookie;
      const authorization = response.trailers.authorization;
      const distinct = response.trailersDistinct["x-reply"];
      console.log(`response body=${body} head=${heads === undefined ? "-" : heads.join("|")} reply=${reply === undefined ? "-" : reply} cookie=${cookie === undefined ? "-" : cookie} auth=${authorization === undefined ? "-" : authorization}`);
      console.log(`response distinct=${distinct === undefined ? "-" : distinct.join("|")} raw=${response.rawTrailers.join("|")}`);
      server.close();
    });
  });
  outbound.flushHeaders();
  outbound.cork();
  outbound.write("o");
  outbound.cork();
  outbound.write("k");
  console.log(`request corked=${outbound.writableCorked}`);
  outbound.uncork();
  outbound.uncork();
  console.log(`request uncorked=${outbound.writableCorked}`);
  outbound.addTrailers({ "X-Sent": "yes" });
  outbound.end();
});
