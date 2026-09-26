import { createServer, request } from "node:http";

const server = createServer((incoming, outgoing) => {
  const headers = incoming.headersDistinct;
  const requestValue = headers["x-request"];
  console.log("request headers", requestValue === undefined ? "-" : requestValue.join("|"), Object.keys(headers).includes("host"), headers.missing === undefined);
  console.log("request raw headers", incoming.rawHeaders.includes("X-Request"));
  console.log("request early raw trailers", incoming.rawTrailers.length);
  incoming.resume();
  incoming.on("end", () => {
    const trailers = incoming.trailersDistinct;
    const trailerValue = trailers["x-tail"];
    console.log("request trailers", trailerValue === undefined ? "-" : trailerValue.join("|"), Object.keys(trailers).join(","));
    outgoing.writeHead(207, ["X-Reply", "first", "x-reply", "second", "Trailer", "X-Tail"]);
    outgoing.write("ok");
    outgoing.addTrailers([["X-Tail", "alpha"], ["x-tail", "beta"]]);
    outgoing.end();
  });
});

server.listen(0, () => {
  const outbound = request({ port: server.address().port, method: "POST", headers: { "X-Request": "one", Trailer: "X-Tail", "Transfer-Encoding": "chunked" } }, (response) => {
    const headers = response.headersDistinct;
    const replyValue = headers["x-reply"];
    console.log("response headers", replyValue === undefined ? "-" : replyValue.join("|"), Object.keys(headers).includes("x-reply"), headers.missing === undefined);
    console.log("response raw headers", response.rawHeaders.includes("X-Reply"), response.rawHeaders.includes("x-reply"));
    console.log("response early raw trailers", response.rawTrailers.length);
    response.resume();
    response.on("end", () => {
      const trailers = response.trailersDistinct;
      const trailerValue = trailers["x-tail"];
      console.log("response trailers", trailerValue === undefined ? "-" : trailerValue.join("|"), Object.keys(trailers).join(","));
      server.close();
    });
  });
  outbound.write("ok");
  outbound.addTrailers([["X-Tail", "one"], ["x-tail", "two"]]);
  outbound.end();
});
