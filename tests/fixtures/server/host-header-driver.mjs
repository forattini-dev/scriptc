import { connect } from "node:net";

function request(port, wire) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks = [];
    socket.on("connect", () => socket.write(wire));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", reject);
  });
}

export async function run(port, requireHostHeader = true) {
  const cases = [
    ["missing-host", "GET /missing HTTP/1.1\r\nConnection: close\r\n\r\n"],
    ["http-1.0", "GET /legacy HTTP/1.0\r\nConnection: close\r\n\r\n"],
    ["mixed-case-host", "GET /mixed HTTP/1.1\r\nhOsT: localhost\r\nConnection: close\r\n\r\n"],
    ["valid-host", "GET /quit HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"],
  ];
  for (const [name, wire] of cases) {
    const response = await request(port, wire);
    console.log(name + " -> " + response.split("\r\n", 1)[0]);
    if (name === "missing-host" && requireHostHeader) {
      console.log("missing-host wire -> " + JSON.stringify(response.replace(/^Date: .*\r\n/m, "Date: <now>\r\n")));
    }
  }
}
