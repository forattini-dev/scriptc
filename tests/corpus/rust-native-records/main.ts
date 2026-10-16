// @no-engine
export {};
interface BuildInfo {
  app: string;
  version: string;
  gitSha?: string;
  nested: { count: number; enabled: boolean };
}
function mark(value: number): number {
  console.log("field", value);
  return value;
}
function build(app: string): BuildInfo {
  return { version: "1.2.3", app, nested: { enabled: true, count: mark(1) } };
}
function mutate(info: BuildInfo): number {
  info.nested.count = 9;
  info.gitSha = "abc";
  return 2;
}
function same(info: BuildInfo): BuildInfo { return info; }
const info = build("red-skills");
const alias = same(info);
console.log("record", info.app, info.version, alias === info);
console.log("borrow", info.nested.count + mutate(alias), info.nested.count);
function revision(info: BuildInfo): string {
  if (info.gitSha !== undefined) { return info.gitSha; }
  return "missing";
}
console.log("optional", revision(info), revision(build("other")));
alias.gitSha = undefined;
console.log("cleared", alias.gitSha === undefined, revision(info));
interface LaunchProbeResult {
  status: number | null;
  timedOut?: boolean;
  error?: string;
}
type Verdict = "runnable" | "unrunnable" | "inconclusive";
function classify(result: LaunchProbeResult): Verdict {
  if (result.timedOut === true) { return "inconclusive"; }
  if (result.status !== null && result.status >= 0) { return "runnable"; }
  return result.error === undefined ? "inconclusive" : "unrunnable";
}
console.log("probe", classify({ status: 0 }), classify({ status: null, timedOut: true }), classify({ error: "failed", status: null }));
function choice(flag: boolean): string | number {
  return flag ? "selected" : 42;
}
function report(value: string | number): void {
  // Compare payloads, not just union tags.
  console.log("union", value === "selected", value !== 42);
}
report(choice(true));
report(choice(false));
function win(p: { os: "linux" | "windows"; workstation?: "windows-wsl" | "windows-native" }): boolean {
  return p.os === "windows" && p.workstation === "windows-wsl";
}
console.log("platform", win({ os: "windows", workstation: "windows-wsl" }), win({ os: "linux" }));
// Field evaluation follows source order, even when shape fields sort differently.
const order = { z: mark(2), a: mark(3) };
console.log("order", order.z, order.a);
function short(): boolean { console.log("unexpected"); return true; }
function logical(flag: boolean): boolean { return flag && short(); }
console.log("short", logical(false));
function optionalInfo(flag: boolean, value: BuildInfo): BuildInfo | null {
  return flag ? value : null;
}
console.log("identity", optionalInfo(true, info) === alias, optionalInfo(true, info) === build("red-skills"), optionalInfo(false, info) === null);
function optionalNumber(flag: boolean): number | undefined {
  return flag ? 0 / 0 : undefined;
}
function equalNumbers(left: number | undefined, right: number | undefined): boolean {
  return left === right;
}
console.log("nan", equalNumbers(optionalNumber(true), optionalNumber(true)), equalNumbers(optionalNumber(false), optionalNumber(false)));
same(info).nested.count = mutate(info);
console.log("write-borrow", info.nested.count);
function nullableBuild(flag: boolean): BuildInfo | null {
  return flag ? { app: "nullable", version: "2", nested: { count: 3, enabled: false } } : null;
}
function nestedInfo(value: BuildInfo | null): string {
  if (value === null) { return "none"; }
  return value.app;
}
console.log("nullable-record", nestedInfo(nullableBuild(true)), nestedInfo(nullableBuild(false)));
