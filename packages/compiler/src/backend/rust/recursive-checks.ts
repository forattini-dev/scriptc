import { typeKey, type IrType, type SrcLoc } from "../../ir/ir.js";
import { recursiveNativeReference } from "../../ir/recursive-native.js";
import type { RustDynamicContext } from "./dynamic-context.js";

interface Check { name: string; type: IrType; loc: SrcLoc | undefined; }

/** Named checked views keep recursive conversion code finite. Validation's
 * active path is keyed by both object identity and the required native type. */
export class RecursiveNativeChecks {
  private readonly names = new Map<string, string>();
  private readonly checks: Check[] = [];
  private emitted = 0;
  private supportEmitted = false;
  constructor(private readonly context: RustDynamicContext) {}

  get pending(): boolean { return this.emitted < this.checks.length; }

  call(type: IrType, value: string, loc: SrcLoc | undefined, path: string): string | undefined {
    if (!recursiveNativeReference(type, id => this.context.records.get(id), id => this.context.union(id, loc))) return undefined;
    const key = typeKey(type);
    let name = this.names.get(key);
    if (name === undefined) {
      name = `sc_recursive_check_${this.checks.length}`;
      this.names.set(key, name);
      this.checks.push({ name, type, loc });
    }
    return `${name}(${value}, ${path})`;
  }

  emitDefinitions(check: (type: IrType, value: string, loc: SrcLoc | undefined, path: string) => string): void {
    if (this.pending && !this.supportEmitted) {
      this.supportEmitted = true;
      this.context.line("thread_local! { static SC_NATIVE_CHECKS: std::cell::RefCell<Vec<(usize, &'static str)>> = const { std::cell::RefCell::new(Vec::new()) }; }");
      this.context.line("struct ScNativeCheckGuard { key: (usize, &'static str) }");
      this.context.line("impl ScNativeCheckGuard { fn enter(identity: usize, layout: &'static str) -> Option<Self> { let key = (identity, layout); SC_NATIVE_CHECKS.with(|active| { let mut active = active.borrow_mut(); if active.contains(&key) { None } else { active.push(key); Some(Self { key }) } }) } }");
      this.context.line("impl Drop for ScNativeCheckGuard { fn drop(&mut self) { SC_NATIVE_CHECKS.with(|active| { assert_eq!(active.borrow_mut().pop(), Some(self.key)); }); } }");
    }
    while (this.pending) {
      const entry = this.checks[this.emitted++];
      if (entry === undefined) throw new Error("scriptc: missing recursive check");
      this.context.line(`fn ${entry.name}(value: ${this.context.dynTypeName()}, path: &str) -> ${this.context.rustType(entry.type, entry.loc)} { ${check(entry.type, "value", entry.loc, "path")} }`);
    }
  }
}
