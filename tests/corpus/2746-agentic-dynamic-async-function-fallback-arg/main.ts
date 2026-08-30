// @dynamic
// A typed test seam commonly overrides an imported async helper whose first
// argument is required and whose dependency bag is optional and function-rich.
import { readFacts } from "facts-reader";

interface ReadDeps {
  readonly nowMs?: () => number;
  readonly readCache?: (root: string) => string | null;
}

interface Facts {
  basename: string;
  count?: number;
}

interface ReaderIO {
  readonly read?: (root: string, deps?: ReadDeps) => Promise<Facts>;
}

async function collect(root: string, io: ReaderIO = {}): Promise<Facts> {
  return await (io.read ?? readFacts)(root);
}

function printFacts(facts: Facts): void {
  console.log(facts.basename, facts.count);
}

printFacts(await collect("/project"));
printFacts(await collect("/override", {
  read: async (root, _deps): Promise<Facts> => ({ basename: root.slice(1), count: 9 }),
}));
