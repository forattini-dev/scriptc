import type { Server } from "node:net";

let server: Server;

function closeServer(value: Server): void {
  server = value;
  server.close();
}

const fake = { close(): void { console.log("closed"); } } as unknown as Server;
closeServer(fake);
