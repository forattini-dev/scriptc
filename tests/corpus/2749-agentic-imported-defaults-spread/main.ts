// @dynamic
// Agent-written configuration layers commonly spread a package's typed default
// record first, then override a few fields locally.
import { DEFAULTS } from "typed-defaults";

interface Options {
  mode: string;
  project: string | null;
  maxWorkers: number;
  verbose: boolean;
}

const resolved: Options = {
  ...DEFAULTS,
  mode: "local",
  maxWorkers: 6,
};

console.log(
  resolved.mode,
  resolved.project,
  resolved.maxWorkers,
  resolved.verbose,
);
