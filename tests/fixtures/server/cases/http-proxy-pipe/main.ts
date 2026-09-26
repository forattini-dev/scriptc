/* The proxy pipes, end to end: a mini reverse proxy over the portless
 * shapes — http.request({ createConnection }) dialing the backend,
 * req.pipe(proxyReq) forwarding the request body, and
 * proxyRes.pipe(res) forwarding the response body. Both servers live in
 * this program; the driver talks to the proxy only. */
import * as http from "node:http";
import * as net from "node:net";

let backendPort = 0;

const backend = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c.toString("utf8");
  });
  req.on("end", () => {
    console.log(`backend ${req.method} ${req.url} host=${req.headers.host} body=${body}`);
    res.writeHead(200, { "content-type": "text/plain", "x-backend": "1" });
    res.end(`echo ${req.method} ${req.url} body=${body}`);
  });
});

const proxy = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url === "/quit") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("bye");
    proxy.close(() => {
      console.log("proxy closed");
      backend.close(() => console.log("backend closed"));
    });
    return;
  }
  const proxyReq = http.request(
    {
      createConnection: () => net.connect(backendPort),
      path: req.url,
      method: req.method,
      headers: { host: "backend.localhost" },
    },
    (proxyRes: http.IncomingMessage) => {
      const sc = proxyRes.statusCode;
      res.writeHead(sc === undefined ? 502 : sc, { "x-proxied": "1" });
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("bad gateway");
    }
  });
  req.pipe(proxyReq);
});

backend.listen(0, () => {
  backendPort = backend.address().port;
  proxy.listen(0, () => {
    console.log("listening");
    process.stderr.write(`PORT ${proxy.address().port}\n`);
  });
});
