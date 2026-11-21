import { typeEquals, type IrModule, type IrType, type SrcLoc } from "./ir.js";

/** Symbol keys retain their identity even when no call needs a method body. */
export function validateSymbolMethods(mod: IrModule): { message: string; loc: SrcLoc }[] {
  const errors: { message: string; loc: SrcLoc }[] = [];
  for (const cls of mod.classes ?? []) {
    const seen = new Set<string>();
    for (const descriptor of cls.symbolMethods ?? []) {
      const bad = (message: string) => errors.push({ message: `class ${cls.name}: ${message}`, loc: cls.loc });
      const unique = /^unique:([1-9][0-9]*)$/.exec(descriptor.key);
      const validUnique = unique !== null && Number(unique[1]) <= 0xffff_ffff;
      if (cls.runtime || !(descriptor.key === "iterator" || descriptor.key === "asyncIterator" || validUnique) || seen.has(descriptor.key)) {
        bad("invalid symbol method surface");
      }
      seen.add(descriptor.key);
      if (descriptor.function === undefined) continue;
      const fn = mod.functions.find(fn => fn.name === descriptor.function);
      if (!fn || descriptor.function !== `%${cls.name}.%symbol.${descriptor.key}` ||
          (fn.captures?.length ?? 0) !== 0 || !fn.params[0] ||
          !typeEquals(fn.params[0].type, { kind: "object", className: cls.name })) {
        bad("invalid symbol method receiver/function");
      }
    }
  }
  return errors;
}

/** Dynamic mirrors cannot yet expose these prototype descriptors. Include
 * possible subtypes and composite values so boxing cannot silently erase them. */
export function containsSymbolMethods(type: IrType, mod: IrModule): boolean {
  if (!(mod.classes ?? []).some(cls => (cls.symbolMethods?.length ?? 0) > 0)) return false;
  const classes = new Map((mod.classes ?? []).map(cls => [cls.name, cls]));
  function subclass(child: string, parent: string): boolean {
    const seen = new Set<string>();
    for (let cls = classes.get(child); cls && !seen.has(cls.name); cls = cls.base ? classes.get(cls.base) : undefined) {
      if (cls.name === parent) return true;
      seen.add(cls.name);
    }
    return false;
  }
  const seen = new Set<IrType>();
  function visit(type: IrType): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    switch (type.kind) {
      case "object": return [...classes.values()].some(cls =>
        (subclass(cls.name, type.className) || subclass(type.className, cls.name)) &&
        ((cls.symbolMethods?.length ?? 0) > 0 || cls.fields.some(field => visit(field.type))));
      case "array": case "set": return visit(type.elem);
      case "promise": return visit(type.inner);
      case "map": return visit(type.key) || visit(type.value);
      case "func": return type.params.some(visit) || visit(type.ret);
      case "record": {
        const record = mod.records?.find(record => record.id === type.shapeId);
        return record !== undefined && (record.fields.some(field => visit(field.type)) ||
          (record.indexValue !== undefined && visit(record.indexValue)));
      }
      case "union": return mod.unions?.find(union => union.id === type.unionId)?.arms.some(visit) ?? false;
      default: return false;
    }
  }
  return visit(type);
}
