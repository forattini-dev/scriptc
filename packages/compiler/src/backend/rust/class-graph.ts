import type { IrFunction, SrcLoc } from "../../ir/ir.js";
import type { RustClassMeta } from "./model.js";

/** Link class metadata into its inheritance forest (base/children,
 * preorder numbering for `instanceof`, hierarchy flags) and collect each
 * root's virtual-method slots. Split from emitter.ts (the 1200-line
 * ceiling); the emitter calls it once after collecting classMeta. */
export function buildRustClassGraph(
  classMeta: ReadonlyMap<string, RustClassMeta>,
  functions: ReadonlyMap<string, IrFunction>,
  unsupported: (kind: string, loc?: SrcLoc) => never,
): void {
  for (const meta of classMeta.values()) {
    if (meta.def.base === undefined) continue;
    const base = classMeta.get(meta.def.base);
    if (base === undefined) continue;
    meta.base = base;
    base.children.push(meta);
  }
  let pre = 0;
  const number = (meta: RustClassMeta, root: RustClassMeta): void => {
    meta.root = root;
    meta.pre = pre++;
    for (const child of meta.children) number(child, root);
    meta.post = pre - 1;
  };
  for (const meta of classMeta.values()) {
    if (meta.base === null) number(meta, meta);
  }
  for (const meta of classMeta.values()) {
    meta.hierarchy = meta.base !== null || meta.children.length > 0;
  }
  const declares = (meta: RustClassMeta, method: string): boolean => meta.def.methods?.includes(method) ?? false;
  const declaredBelow = (meta: RustClassMeta, method: string): boolean =>
    meta.children.some((child) => declares(child, method) || declaredBelow(child, method));
  const collectSlots = (meta: RustClassMeta, root: RustClassMeta): void => {
    for (const method of meta.def.methods ?? []) {
      let inherited = false;
      for (let ancestor = meta.base; ancestor !== null; ancestor = ancestor.base) {
        inherited ||= declares(ancestor, method);
      }
      if (!inherited && declaredBelow(meta, method)) {
        let fn = functions.get(`%${meta.def.name}.${method}`);
        if (fn === undefined && meta.def.abstractMethods?.includes(method)) {
          const findImplementation = (candidate: RustClassMeta): IrFunction | undefined => {
            for (const child of candidate.children) {
              const implementation = child.def.methods?.includes(method) && !child.def.abstractMethods?.includes(method)
                ? functions.get(`%${child.def.name}.${method}`)
                : undefined;
              const found = implementation ?? findImplementation(child);
              if (found !== undefined) return found;
            }
            return undefined;
          };
          fn = findImplementation(meta);
          if (fn === undefined) continue;
        }
        if (fn === undefined) unsupported(`missing virtual method '${meta.def.name}.${method}'`, meta.def.loc);
        root.slots.push({ method, declarer: meta, fn });
      }
    }
    for (const child of meta.children) collectSlots(child, root);
  };
  for (const meta of classMeta.values()) {
    if (meta.base === null && meta.hierarchy) collectSlots(meta, meta);
  }
}
