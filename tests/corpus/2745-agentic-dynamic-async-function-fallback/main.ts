// @dynamic
// Agent-written adapters commonly expose a typed test override and otherwise
// call an async function imported from a dynamically embedded package.
import { readPayload } from "payload-reader";

interface ReadOptions {
  readonly deadlineMs?: number;
  readonly stream?: { pause: () => unknown };
}

type Payload = null | {
  cwd?: string;
  meta: { count?: number };
};

interface ReaderIO {
  readonly read?: (options?: ReadOptions) => Promise<Payload>;
}

async function collect(io: ReaderIO = {}): Promise<Payload> {
  return await (io.read ?? readPayload)();
}

function printPayload(payload: Payload): void {
  console.log(payload?.cwd, payload?.meta.count);
}

printPayload(await collect());
printPayload(await collect({
  read: async () => ({ cwd: "/override", meta: { count: 7 } }),
}));
