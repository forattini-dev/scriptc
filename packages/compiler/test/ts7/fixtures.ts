/* The parity battery's fixture programs: one source map per program, chosen
 * to cover the census's AST surface (every guard family fires somewhere),
 * the checker query shapes the lowering makes, JS-with-CJS inference, module
 * graphs with aliases, and diagnostics of several kinds. */

export const RICH_TS: Record<string, string> = {
  "rich.ts": `export interface Shape { kind: "circle" | "square"; size: number }
export type Pair<T> = readonly [T, T];
export class Box<T> {
  private contents: T[] = [];
  static count = 0;
  constructor(readonly label: string) { Box.count++; }
  get first(): T | undefined { return this.contents[0]; }
  set first(v: T | undefined) { if (v !== undefined) this.contents[0] = v; }
  async load(items: Promise<T[]>): Promise<number> {
    const resolved = await items;
    this.contents.push(...resolved);
    return this.contents.length;
  }
}
export const enum Dir { Up, Down }
const { a, b: renamed, ...rest } = { a: 1, b: "two", c: true };
const [x = 5, , ...ys] = [1, 2, 3, 4];
const lit = [1, , 2];
const tpl = \`a=\${a} renamed=\${renamed} rest=\${JSON.stringify(rest)} lit=\${lit.length}\`;
function over(v: string): number;
function over(v: number): string;
function over(v: string | number): number | string { return typeof v === "string" ? v.length : String(v); }
const arrow = async (n: number): Promise<Pair<number>> => [n, n] as const;
void arrow;
const maybe: Shape | null = Math.random() > 0.5 ? { kind: "circle", size: 1 } : null;
if (maybe?.kind === "circle") { void maybe.size; }
for (const y of ys) { switch (y) { case 3: break; default: continue; } }
label: for (let i = 0; i < 2; i++) { if (i) break label; }
do { void 0; } while (false);
let w = 0; while (w < 1) { w++; }
try { throw new Error(tpl); } catch (e) { void e; } finally { void 0; }
const del = { p: 1 } as { p?: number }; delete del.p;
const re = /ab+c/g; void re.source;
const big = 10n ** 2n; void big;
const computed = { ["k" + "ey"]: 1, short: x, method() { return this.short; }, get g() { return 1; }, set g(_v: number) {} };
void computed;
const spread = { ...del, q: 2 }; void spread;
const idx = spread["q"]; void idx;
const nn = maybe!; void nn;
void (x satisfies number);
void typeof tpl;
const neg = -x; const post = ys.length; void [neg, post];
class UnionLeft {
  leftOnly(): string { return "left"; }
  common(prefix: string): string { return prefix + ":left"; }
}
class UnionRight {
  rightOnly(): string { return "right"; }
  common(prefix: string): string { return prefix + ":right"; }
}
function unionCalls(items: UnionLeft[] | UnionRight[], value: UnionLeft | UnionRight): string[] {
  items.forEach((item) => void item.common("each"));
  const mapped = items.map((item, index, array) => item.common(String(index + array.length)));
  mapped.push(value.common("value"));
  return mapped;
}
void unionCalls;
export default over;
`,
};

export const MODULES_TS: Record<string, string> = {
  "lib.ts": `export const answer = 42;
export function greet(name: string): string { return "hi " + name; }
export class Thing { constructor(readonly id: number) {} }
export type Kind = "a" | "b";
`,
  "main.ts": `import { answer, greet, Thing as Renamed, type Kind } from "./lib.ts";
import * as fs from "node:fs";
export { greet } from "./lib.ts";
const t = new Renamed(answer);
const k: Kind = "a";
console.log(greet(String(t.id)), k, typeof fs.readFileSync);
export {};
`,
};

export const CJS_JS: Record<string, string> = {
  "util.js": `const helpers = {
  greet(name) { return "hi " + name; },
  parts: [1, 2, 3],
};
function tail(xs) { return xs[xs.length - 1]; }
helpers.last = tail(helpers.parts);
module.exports = helpers;
module.exports.extra = tail(["a", "b"]);
`,
};

export const ASYNC_TS: Record<string, string> = {
  "async.ts": `export async function fetchCount(): Promise<number> { return 3; }
export async function nested(): Promise<Promise<string>> { return Promise.resolve(Promise.resolve("x")); }
export function ret(): { lanIp: string | null } | PromiseLike<{ lanIp: string | null }> {
  return { lanIp: null };
}
async function driver(): Promise<void> {
  const n = await fetchCount();
  const s = await nested();
  const r = await ret();
  console.log(n, s, r.lanIp);
}
void driver();
export {};
`,
};

export const ERRORS_TS: Record<string, string> = {
  "errors.ts": `const wrong: string = 42;
const missing = notDefined + 1;
function two(a: number, b: string): void { void [a, b]; }
two(1, 2);
const shape: { p: number } = { p: 1, q: 2 };
export {};
`,
};

export interface Battery {
  name: string;
  sources: Record<string, string>;
  /** Diagnostics tsgo reports BEYOND 5.9.3's set, pinned exactly (code +
   * start offset). The cjs battery carries the finding that tsgo models
   * CommonJS JS modules more strictly: `module.exports = table` followed by
   * member writes draws TS2309 on the assignment and TS2339 on the member —
   * 5.9.3's expando-property synthesis accepted both. */
  extraDiags7: { code: number; start: number }[];
  /** True to skip the generic type-string comparison — the cjs battery's
   * finding again: 5.9.3 synthesizes expando members (helpers.last,
   * module.exports.extra) into the object types; tsgo does not, so the CJS
   * table types legitimately differ. Pinned by a dedicated test. */
  skipTypeStrings: boolean;
}

export const ALL_BATTERIES: Battery[] = [
  { name: "rich", sources: RICH_TS, extraDiags7: [], skipTypeStrings: false },
  { name: "modules", sources: MODULES_TS, extraDiags7: [], skipTypeStrings: false },
  {
    name: "cjs",
    sources: CJS_JS,
    extraDiags7: [
      { code: 2309, start: CJS_JS["util.js"]!.indexOf("module.exports = helpers") },
      { code: 2339, start: CJS_JS["util.js"]!.indexOf("extra") },
    ],
    skipTypeStrings: true,
  },
  { name: "async", sources: ASYNC_TS, extraDiags7: [], skipTypeStrings: false },
  { name: "errors", sources: ERRORS_TS, extraDiags7: [], skipTypeStrings: false },
];
