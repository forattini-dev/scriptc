/* Vitest reporter for scripts/gate-rust.mjs: one JSON line per event,
 * appended synchronously to the file named by SCRIPTC_GATE_RESULTS.
 *
 * The built-in JSON reporter writes its file once, at the end of the run,
 * so a shard that is killed (timeout, OOM, a crashed worker) leaves no
 * record of the hundreds of programs it had already judged. This reporter
 * streams instead: every finished test lands on disk before the next one
 * starts, the gate rebuilds the inventory from whatever reached the file,
 * and the tests that never produced a line are reported as "did not run".
 *
 * Event lines (all carry `type`):
 *   run-start        { modules: [relative module ids] }
 *   module-collected { file, tests: [test names in collection order] }
 *   test             { file, name, fullName, state, durationMs, retryCount,
 *                      flaky, note, errors: [first lines of each error] }
 *   module-end       { file, state, durationMs, errors }
 *   console          { file, stream, content } — only the harness's own
 *                    ledger lines ("rust parity: N/M ...")
 *   run-end          { reason, unhandledErrors }
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

const MAX_ERROR_LINES = 8;
const MAX_ERROR_CHARS = 1200;

/** Strip ANSI escapes and keep the head of a message. */
export function firstLines(text, lines = MAX_ERROR_LINES, chars = MAX_ERROR_CHARS) {
  const plain = String(text ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const head = plain.split("\n").slice(0, lines).join("\n");
  return head.length > chars ? `${head.slice(0, chars)}…` : head;
}

function serializeError(error) {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return firstLines(error);
  const name = typeof error.name === "string" && error.name !== "Error" ? `${error.name}: ` : "";
  const message = typeof error.message === "string" ? error.message : String(error);
  return firstLines(`${name}${message}`);
}

export default class GateRustReporter {
  constructor() {
    this.path = process.env["SCRIPTC_GATE_RESULTS"];
    if (!this.path) {
      throw new Error("gate-rust reporter requires SCRIPTC_GATE_RESULTS to name its output file");
    }
    this.root = process.cwd();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, "");
  }

  onInit(vitest) {
    this.root = vitest?.config?.root ?? this.root;
  }

  write(record) {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  file(moduleId) {
    return relative(this.root, moduleId);
  }

  onTestRunStart(specifications) {
    this.write({ type: "run-start", modules: specifications.map((spec) => this.file(spec.moduleId)) });
  }

  onTestModuleCollected(testModule) {
    const tests = [];
    for (const test of testModule.children.allTests()) tests.push(test.name);
    this.write({ type: "module-collected", file: this.file(testModule.moduleId), tests });
  }

  onTestCaseResult(testCase) {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    this.write({
      type: "test",
      file: this.file(testCase.module.moduleId),
      name: testCase.name,
      fullName: testCase.fullName,
      state: result.state,
      durationMs: diagnostic === undefined ? null : Math.round(diagnostic.duration),
      retryCount: diagnostic?.retryCount ?? 0,
      flaky: diagnostic?.flaky ?? false,
      note: result.state === "skipped" ? result.note ?? null : null,
      errors: (result.errors ?? []).map(serializeError),
    });
  }

  onTestModuleEnd(testModule) {
    const diagnostic = testModule.diagnostic();
    this.write({
      type: "module-end",
      file: this.file(testModule.moduleId),
      state: testModule.state(),
      durationMs: Math.round(diagnostic.duration),
      errors: testModule.errors().map(serializeError),
    });
  }

  onUserConsoleLog(log) {
    if (!/rust parity:/.test(log.content)) return;
    this.write({
      type: "console",
      stream: log.type,
      content: firstLines(log.content.trim(), 20, 4000),
    });
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    this.write({
      type: "run-end",
      reason,
      unhandledErrors: unhandledErrors.map(serializeError),
    });
  }
}
