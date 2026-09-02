/* The npm differential case table — npm.test.ts's list, extracted so the
 * Linux lane runs the IDENTICAL cases (same entries, same argv lists)
 * against the in-container Linux Node oracle. The fixture node_modules
 * are COMMITTED TEST DATA; binaries embed the package sources at build
 * time, the Node lane resolves them from the repo mount. */
import { globSync } from "node:fs";
import { join } from "node:path";

export type NpmLane = "c" | "llvm" | "rust";

export interface NpmCase {
  name: string;
  entry: string;
  /** Every argv list runs both sides; default: one run with no args. */
  argvs?: string[][];
  /** Lanes the case is valid on; absent means every lane. */
  lanes?: readonly NpmLane[];
}

/* Cases whose HOST SURFACE only one island answers today. A case listed
 * here is skipped everywhere else rather than made tolerant: a program
 * that prints a fence on one lane and real output on another cannot be
 * byte-diffed against Node at all, and softening it would retire the very
 * differential that makes the lane's number mean something.
 *
 * net-echo-island and http-server-raw-island: raw node:net sockets. The
 * Rust island has the socket bridge (island_host_net.rs); the C island
 * still answers node:net with 30a-net-tls-load.js's loud fence, so both
 * cases would refuse there — the second one because its probe reads the
 * served wire back over a raw socket, which is what makes it an
 * assertion about BYTES rather than about a parser's reading of them. */
const LANE_ONLY: Readonly<Record<string, readonly NpmLane[]>> = {
  "net-echo-island": ["rust"],
  "http-server-raw-island": ["rust"],
};

/** `backend` is the lane being measured; unset is the release default, C. */
export function npmCases(fixturesRoot: string, backend?: NpmLane): NpmCase[] {
  const lane: NpmLane = backend ?? "c";
  const table: NpmCase[] = [
    ...globSync(join(fixturesRoot, "npm/cases/*/main.ts"))
      .sort()
      // 2465-2469 and 2556-2557 are the --npm-static bundler-emitted-CJS
      // cases (npm-static.test.ts drives them with the opt-in): their
      // consumers exercise the static rewrite's surface (lexer-visible
      // names the shipped .d.ts never declares, the __toESM interop
      // family), so they stay out of the flagless island lane by design.
      .filter((entry) => !/\/(246[5-9]|255[67])-[^/]+\/main\.ts$/.test(entry))
      .map((entry) => {
        const name = entry.split("/").at(-2)!;
        const lanes = LANE_ONLY[name];
        return lanes === undefined ? { name, entry } : { name, entry, lanes };
      }),
    {
      // THE acceptance test: a calculator CLI on the real commander package
      // (pinned in the fixture; see its README), across the happy paths,
      // --version/--help (island process.exit), and the error exits.
      name: "commander-calc",
      entry: join(fixturesRoot, "commander-calc/calc.ts"),
      argvs: [
        ["add", "2", "3"],
        ["sub", "10", "4.25"],
        ["mul", "4", "2.5"],
        ["div", "9", "2"],
        ["add", "0.1", "0.2"],
        ["add", "1e3", "-0.5"],
        // The typed async action (string|undefined + options record + async
        // body): omitted argument -> the undefined arm; option flags ->
        // record fields (missing ones take their undefined arms); the
        // trailing Command argument drops.
        ["echo", "hello"],
        ["echo"],
        ["echo", "hello", "--upper"],
        ["echo", "hello", "-p", "say: "],
        ["echo", "--upper", "-p", "p: ", "mixed"],
        ["--version"],
        ["--help"],
        ["add", "2"], // missing argument: usage error, exit 1
        ["boom"], // unknown command: suggestion error, exit 1
        [], // no command: help to stderr, exit 1
        // The rejecting async action under plain parse(): nobody observes
        // the rejection — the unhandled-rejection report fires, exit 1.
        ["fail", "flat tire"],
      ],
    },
    {
      // The classic CLI ENTRY LINE: parseAsync's engine promise bridges into a
      // static one; the rejecting async action reaches the inline .catch
      // handler (typed-catch narrowing, stderr message, exit 1) — the full
      // round trip through BOTH promise bridges (the action's static
      // promise wraps into the engine, commander's result promise bridges
      // back out).
      name: "commander-calc-async",
      entry: join(fixturesRoot, "commander-calc/calc-async.ts"),
      argvs: [
        ["double", "21"],
        ["fail", "flat tire"],
        ["--help"],
        ["boom"], // unknown command: island process.exit path, exit 1
      ],
    },
  ];
  return table.filter((c) => c.lanes === undefined || c.lanes.includes(lane));
}
