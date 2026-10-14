import { appendFileSync, readFileSync } from "node:fs";

export default class RustCorpusReporter {
  constructor() {
    this.allowed = process.env.SCRIPTC_RUST_CASE_INVENTORY
      ? new Set(JSON.parse(readFileSync(process.env.SCRIPTC_RUST_CASE_INVENTORY, "utf8"))) : null;
  }
  record(test, value) {
    const output = process.env.SCRIPTC_RUST_CASE_REPORT;
    const program = test.name.replaceAll("\\", "/");
    if (output && (!this.allowed || this.allowed.has(program)))
      appendFileSync(output, JSON.stringify({ program, at: new Date().toISOString(), ...value }) + "\n");
  }
  onTestCaseReady(test) { this.record(test, { event: "start" }); }
  onTestCaseResult(test) {
    const result = test.result();
    this.record(test, {
      event: "result", state: result.state, note: result.note, diagnostic: test.diagnostic(),
      errors: result.errors?.map(error => ({ name: error.name, message: error.message, stack: error.stack, actual: error.actual, expected: error.expected })),
    });
  }
}
