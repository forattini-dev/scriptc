/**
 * Locating the interpreters of the compat matrix, and choosing which one a
 * given check should talk to.
 *
 * The matrix forces a distinction the single-pin world never had to make,
 * and getting it wrong is how a dual-target suite turns into a coin flip:
 *
 *  - The CENSUS follows the HOST. "What members does URL expose?" is a
 *    question about the runtime the suite is running on, and the whole
 *    point of running the suite twice is to ask it of both majors.
 *
 *  - The SEMANTIC ORACLE stays PINNED to the primary. "What exactly does
 *    Node print here?" is a question a compiled binary answers with one
 *    fixed answer: the native runtime reproduces one Node's observable
 *    behavior, error-message text included, and it cannot reproduce two.
 *    Node 26 rewords messages Node 24 emits — AbortSignal.any's
 *    ERR_INVALID_ARG_TYPE went from "signals can not be converted to
 *    sequence." to "signals cannot be converted to sequence." — so a
 *    differential that compared native output against whichever Node
 *    happened to be running would red on message spelling and say nothing
 *    about the compiler.
 *
 * So a differential check asks for `primaryOracleExecutable`, which is the
 * primary target's interpreter unless SCRIPTC_NODE_ORACLE names another —
 * the override is how you deliberately go looking for divergences instead
 * of tripping over them.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compatTargetList, type CompatRuntimeTarget, type CompatTargets } from "@scriptc/compiler";

/** Ask a candidate interpreter its version, without the leading "v".
 * Returns null when it cannot be executed, so a stale path falls through
 * to the next candidate instead of aborting the search. */
export function interpreterVersion(executable: string): string | null {
  try {
    return execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

function miseWhich(version: string): string | null {
  try {
    return execFileSync("mise", ["which", `node@${version}`], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The environment variable that pins one target's interpreter explicitly:
 * the escape hatch for a host that manages Node some way this module does
 * not know about. */
export function matrixExecutableVariable(target: CompatRuntimeTarget): string {
  return `SCRIPTC_NODE_${target.id.toUpperCase()}`;
}

/**
 * The interpreter for one matrix target. Candidates are tried in order —
 * explicit override, the running interpreter, the mise install tree, `mise
 * which` — and every one of them is asked for its --version and rejected
 * on disagreement, because a moved symlink would otherwise let the "Node
 * 26 lane" quietly run Node 24 and report success.
 */
export function resolveMatrixExecutable(
  target: CompatRuntimeTarget,
  env: NodeJS.ProcessEnv = process.env,
  hostExecutable: string = process.execPath,
): string {
  const variable = matrixExecutableVariable(target);
  const override = env[variable];
  const miseData = env["MISE_DATA_DIR"] ?? join(homedir(), ".local/share/mise");
  const candidates = [
    override,
    hostExecutable,
    join(miseData, "installs/node", target.node, "bin/node"),
    miseWhich(target.node),
  ].filter((candidate): candidate is string =>
    candidate !== undefined && candidate !== null && candidate !== "",
  );

  const rejected: string[] = [];
  for (const candidate of candidates) {
    if (candidate !== hostExecutable && !existsSync(candidate)) continue;
    const version = interpreterVersion(candidate);
    if (version === target.node) return candidate;
    // A wrong-version explicit override is an error worth surfacing, not a
    // candidate to skip past silently.
    if (candidate === override) {
      throw new Error(
        `${variable} points at ${candidate}, which reports Node ${version ?? "nothing"} — ` +
          `the ${target.id} target is Node ${target.node}`,
      );
    }
    if (version !== null) rejected.push(`${candidate} (Node ${version})`);
  }

  throw new Error(
    `no Node ${target.node} interpreter found for target '${target.id}'. ` +
      `Install it (mise install node@${target.node}) or point ${variable} at one.` +
      (rejected.length > 0 ? ` Rejected: ${rejected.join(", ")}.` : ""),
  );
}

/**
 * The interpreter a DIFFERENTIAL check should compare native output
 * against: SCRIPTC_NODE_ORACLE when set, otherwise the matrix primary —
 * never "whatever is running". See this module's header for why.
 */
export function primaryOracleExecutable(
  targets: CompatTargets,
  env: NodeJS.ProcessEnv = process.env,
  hostExecutable: string = process.execPath,
): string {
  const override = env["SCRIPTC_NODE_ORACLE"];
  if (override !== undefined && override !== "") return override;
  return resolveMatrixExecutable(targets.primary, env, hostExecutable);
}

/** Every declared target, primary first — re-exported so a caller needs
 * one import for the matrix rather than two. */
export function matrixTargets(targets: CompatTargets): readonly CompatRuntimeTarget[] {
  return compatTargetList(targets);
}
