// Response Headers preserve Set-Cookie fields as separate values.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.end(
    "HTTP/1.1 200 OK\r\n" +
    "Set-Cookie: session=one; Path=/\r\n" +
    "Set-Cookie: theme=dark; Path=/\r\n" +
    "Content-Length: 0\r\n" +
    "Connection: close\r\n\r\n",
  );
});

async function readCookies(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/cookies`);
  console.log(response.headers.getSetCookie().join("|"));
  server.close();
}

server.listen(0, "127.0.0.1", () => {
  void readCookies(server.address().port);
});
