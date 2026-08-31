import { createSocket } from "node:dgram";
import * as net from "node:net";

// TCP remains idle while the harness delivers UDP. A unified descriptor wait
// should wake for either source without a 1 ms cross-source polling loop.
const before = process.resourceUsage().voluntaryContextSwitches;
let tcpReady = false;
let udpReady = false;
const ready = () => {
  if (tcpReady && udpReady) console.log("ready");
};

const tcp = net.connect(Number(process.argv[2]), "127.0.0.1", () => {
  tcpReady = true;
  ready();
});
tcp.on("data", () => {});

const udp = createSocket("udp4");
udp.on("listening", () => {
  udpReady = true;
  ready();
});
udp.on("message", (message) => {
  const after = process.resourceUsage().voluntaryContextSwitches;
  console.log(message.toString(), after - before < 100);
  udp.close();
  tcp.end();
});
udp.bind(Number(process.argv[3]), "127.0.0.1");
