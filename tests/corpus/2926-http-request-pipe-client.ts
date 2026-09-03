import * as http from "node:http";

const target = http.createServer((request, response) => {
  console.log("target request");
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    console.log("target end");
    response.end(`target:${body}`);
  });
});

const proxy = http.createServer((request, response) => {
  console.log("proxy request");
  const outbound = http.request({
    host: "127.0.0.1",
    port: target.address().port,
    method: "POST",
    headers: { "content-length": "4" },
  }, (upstream) => {
    console.log("upstream response");
    upstream.on("data", (chunk: Buffer) => {
      response.write(chunk);
    });
    upstream.on("end", () => response.end());
  });
  request.pipe(outbound);
});

target.listen(0, "127.0.0.1", () => {
  proxy.listen(0, "127.0.0.1", () => {
    const request = http.request({
      host: "127.0.0.1",
      port: proxy.address().port,
      method: "POST",
      headers: { "content-length": "4" },
    }, (response) => {
      console.log("client response");
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        console.log(body);
        proxy.close();
        target.close();
      });
    });
    request.end("ping");
  });
});
