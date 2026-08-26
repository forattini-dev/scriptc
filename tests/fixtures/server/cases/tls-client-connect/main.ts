import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { connect } from "node:tls";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
let port = 0;

function trusted(): void {
  const socket = connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    ca,
  }, () => {
    console.log(`trusted callback authorized=${socket.authorized} auth=${socket.authorizationError}`);
    const encrypted = (socket as typeof socket & { encrypted?: boolean }).encrypted;
    console.log(`trusted encrypted=${encrypted} remote=${socket.remoteAddress !== undefined}`);
    socket.end("quit");
  });
  socket.once("secureConnect", () => console.log("trusted secureConnect"));
  socket.on("data", (chunk: Buffer) => console.log(`trusted data=${chunk.toString("utf8")}`));
  socket.on("end", () => console.log("trusted end"));
  socket.on("close", () => console.log("trusted close"));
  socket.on("error", (error) => console.log(`trusted unexpected ${error.message}`));
}

function insecure(): void {
  const socket = connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    rejectUnauthorized: false,
  }, () => {
    console.log(`insecure callback authorized=${socket.authorized} auth=${socket.authorizationError}`);
    socket.write("alpha");
  });
  socket.once("secureConnect", () => console.log("insecure secureConnect"));
  socket.on("data", (chunk: Buffer) => console.log(`insecure data=${chunk.toString("utf8")}`));
  socket.on("end", () => console.log("insecure end"));
  socket.on("close", () => {
    console.log("insecure close");
    trusted();
  });
  socket.on("error", (error) => console.log(`insecure unexpected ${error.message}`));
}

function refused(): void {
  let certificateFailure = false;
  const socket = connect({ port, host: "127.0.0.1", servername: "localhost" });
  socket.on("error", (error) => {
    if (error.message.startsWith("connect ")) {
      setTimeout(refused, 25);
      return;
    }
    certificateFailure = true;
    console.log(`default error=${error.message}`);
  });
  socket.on("close", () => {
    if (certificateFailure) {
      console.log("default close");
      insecure();
    }
  });
}

const probe = createServer();
probe.listen(0, "127.0.0.1", () => {
  port = probe.address().port;
  probe.close(() => {
    process.stderr.write(`PORT ${port}\n`);
    refused();
  });
});
