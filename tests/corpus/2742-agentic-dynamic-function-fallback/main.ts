// @dynamic
// Agent-written services commonly keep a typed test override and fall back to
// a function imported from a dynamically embedded package.
import { isPidAlive } from "pid-probe";

interface ProbeOptions {
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

async function probe(pid: number, options: ProbeOptions = {}): Promise<boolean> {
  const pidAlive = options.isPidAlive ?? isPidAlive;
  return await pidAlive(pid);
}

console.log(await probe(42));
console.log(await probe(7, { isPidAlive: async (pid) => pid === 7 }));
