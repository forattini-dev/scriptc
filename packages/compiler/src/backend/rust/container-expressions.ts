import type { IrExpr, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";

export interface RustContainerExpressionContext {
  nextTemporary(): string;
  emitExpr(expr: IrExpr): string;
  arrayElementEquality(left: string, right: string, type: IrType, sameValueZero: boolean, loc: SrcLoc): string;
  mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string;
  mapStoredKey(value: string, type: IrType): string;
  rustBytesElement(elem: "u8" | "u32" | "i32" | "f32"): string;
  isUnit(type: IrType): boolean;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export class RustContainerExpressionEmitter {
  constructor(private readonly context: RustContainerExpressionContext) {}

  emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string {
    return this.emitArrayIntrinsicValues(
      expr,
      this.context.emitExpr(expr.receiver),
      expr.args.map((arg) => this.context.emitExpr(arg)),
    );
  }

  emitArrayGetValues(
    expr: Extract<IrExpr, { kind: "arrayGet" }>,
    array: string,
    index: string,
  ): string {
    if (expr.arr.type.kind !== "array") this.context.unsupported("async arrayGet on a non-array", expr.loc);
    return `runtime::array_get(&(${array}), ${index})`;
  }

  emitBytesNewValue(
    expr: Extract<IrExpr, { kind: "bytesNew" }>,
    source: string | null,
  ): string {
    if (expr.type.kind !== "bytes") this.context.unsupported("bytes construction result", expr.loc);
    const elem = this.context.rustBytesElement(expr.type.elem);
    if (expr.source === null) return `runtime::bytes_empty::<${elem}>()`;
    if (source === null) this.context.unsupported("missing bytes construction source", expr.loc);
    if (expr.source.type.kind === "f64") return `runtime::bytes_alloc::<${elem}>(${source})`;
    if (expr.source.type.kind === "bytes") return `runtime::bytes_copy(&(${source}))`;
    if (expr.source.type.kind === "array" && expr.source.type.elem.kind === "f64") {
      return `runtime::bytes_from_array::<${elem}>(&(${source}))`;
    }
    this.context.unsupported(`bytes construction from '${expr.source.type.kind}'`, expr.loc);
  }

  emitArrayIntrinsicValues(
    expr: Extract<IrExpr, { kind: "arrIntrinsic" }>,
    receiverExpr: string,
    argExprs: readonly string[],
  ): string {
    if (expr.receiver.type.kind !== "array") this.context.unsupported("array intrinsic on a non-array", expr.loc);
    const elementType = expr.receiver.type.elem;
    const receiver = this.context.nextTemporary();
    switch (expr.method) {
      case "length":
        return `runtime::array_len(&(${receiverExpr}))`;
      case "pop":
        return `runtime::array_pop(&(${receiverExpr}))`;
      case "indexOf":
      case "includes": {
        const needleExpr = argExprs[0];
        if (needleExpr === undefined) this.context.unsupported(`array ${expr.method} without a needle`, expr.loc);
        const needle = this.context.nextTemporary();
        const equality = this.context.arrayElementEquality("left", "right", expr.receiver.type.elem, expr.method === "includes", expr.loc);
        const helper = expr.method === "indexOf" ? "array_index_of_by" : "array_includes_by";
        return `{ let ${receiver} = ${receiverExpr}; let ${needle} = ${needleExpr}; runtime::${helper}(&${receiver}, &${needle}, |left, right| ${equality}) }`;
      }
      case "push": {
        const values = argExprs.map(() => this.context.nextTemporary());
        const bindings = argExprs.map((arg, index) => `let ${values[index]} = ${arg};`).join(" ");
        const pushes = values.map((value) => `runtime::array_push(&${receiver}, ${value});`).join(" ");
        return `{ let ${receiver} = ${receiverExpr}; ${bindings} ${pushes} runtime::array_len(&${receiver}) }`;
      }
      case "pushSpread": {
        const first = argExprs[0];
        if (first === undefined) this.context.unsupported("array pushSpread without a source", expr.loc);
        const source = this.context.nextTemporary();
        return `{ let ${receiver} = ${receiverExpr}; let ${source} = ${first}; runtime::array_extend(&${receiver}, &${source}) }`;
      }
      case "unshift": {
        const values = argExprs.map(() => this.context.nextTemporary());
        const bindings = argExprs.map((arg, index) => `let ${values[index]} = ${arg};`).join(" ");
        return `{ let ${receiver} = ${receiverExpr}; ${bindings} runtime::array_unshift(&${receiver}, vec![${values.join(", ")}]) }`;
      }
      case "unshiftSpread": {
        const first = argExprs[0];
        if (first === undefined) this.context.unsupported("array unshiftSpread without a source", expr.loc);
        const source = this.context.nextTemporary();
        return `{ let ${receiver} = ${receiverExpr}; let ${source} = ${first}; runtime::array_unshift_from(&${receiver}, &${source}) }`;
      }
      case "reverse":
        return `{ let ${receiver} = ${receiverExpr}; runtime::array_reverse(&${receiver}) }`;
      case "toReversed":
        return `{ let ${receiver} = ${receiverExpr}; runtime::array_to_reversed(&${receiver}) }`;
      case "toSpliced": {
        const startExpr = argExprs[0];
        const countExpr = argExprs[1];
        const itemsExpr = argExprs[2];
        if (startExpr === undefined || countExpr === undefined || itemsExpr === undefined) {
          this.context.unsupported("array toSpliced argument shape", expr.loc);
        }
        const start = this.context.nextTemporary();
        const count = this.context.nextTemporary();
        const items = this.context.nextTemporary();
        return `{ let ${receiver} = ${receiverExpr}; let ${start} = ${startExpr}; let ${count} = ${countExpr}; let ${items} = ${itemsExpr}; runtime::array_to_spliced(&${receiver}, ${start}, ${count}, &${items}) }`;
      }
      case "with": {
        const indexExpr = argExprs[0];
        const valueExpr = argExprs[1];
        if (indexExpr === undefined || valueExpr === undefined) this.context.unsupported("array with argument shape", expr.loc);
        const index = this.context.nextTemporary();
        const value = this.context.nextTemporary();
        return `{ let ${receiver} = ${receiverExpr}; let ${index} = ${indexExpr}; let ${value} = ${valueExpr}; runtime::array_with(&${receiver}, ${index}, ${value}) }`;
      }
      case "slice": {
        const start = this.context.nextTemporary();
        const end = this.context.nextTemporary();
        const startExpr = argExprs[0] ?? "0.0";
        const endExpr = argExprs[1] ?? "f64::INFINITY";
        return `{ let ${receiver} = ${receiverExpr}; let ${start} = ${startExpr}; let ${end} = ${endExpr}; runtime::array_slice(&${receiver}, ${start}, ${end}) }`;
      }
      case "splice": {
        const startExpr = argExprs[0];
        if (startExpr === undefined) this.context.unsupported("array splice without a start", expr.loc);
        const start = this.context.nextTemporary();
        const count = this.context.nextTemporary();
        const countExpr = argExprs[1] ?? "f64::INFINITY";
        return `{ let ${receiver} = ${receiverExpr}; let ${start} = ${startExpr}; let ${count} = ${countExpr}; runtime::array_splice(&${receiver}, ${start}, ${count}) }`;
      }
      case "shift": {
        if (expr.type.kind !== "union") this.context.unsupported("array shift without an optional result union", expr.loc);
        const union = this.context.union(expr.type.unionId, expr.loc);
        const valueTag = union.arms.findIndex((arm) => typeKey(arm) === typeKey(elementType));
        const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
        if (valueTag < 0 || undefinedTag < 0) this.context.unsupported("array shift result union shape", expr.loc);
        const name = this.context.unionName(union.id);
        return `{ let ${receiver} = ${receiverExpr}; if runtime::array_len(&${receiver}) == 0.0 { ${name}::${this.context.unionVariant(undefinedTag)} } else { ${name}::${this.context.unionVariant(valueTag)}(runtime::array_shift(&${receiver})) } }`;
      }
      case "join": {
        const separator = argExprs[0];
        if (separator === undefined) this.context.unsupported("array join without a separator", expr.loc);
        const separatorValue = this.context.nextTemporary();
        if (elementType.kind === "union") {
          const union = this.context.union(elementType.unionId, expr.loc);
          const name = this.context.unionName(union.id);
          const arms = union.arms.map((arm, tag) => {
            const variant = `${name}::${this.context.unionVariant(tag)}`;
            if (this.context.isUnit(arm)) return `${variant} => {},`;
            if (arm.kind === "f64") return `${variant}(payload) => output.push_str(&runtime::format_number(*payload)),`;
            if (arm.kind === "bool") return `${variant}(payload) => output.push_str(if *payload { "true" } else { "false" }),`;
            if (arm.kind === "string") return `${variant}(payload) => output.push_str(payload),`;
            this.context.unsupported(`array join union arm '${arm.kind}'`, expr.loc);
          }).join(" ");
          return `{ let ${receiver} = ${receiverExpr}; let ${separatorValue} = ${separator}; runtime::array_join_by(&${receiver}, &${separatorValue}, |value, output| match value { ${arms} }) }`;
        }
        if (elementType.kind !== "f64" && elementType.kind !== "bool" && elementType.kind !== "string") {
          this.context.unsupported(`array join element '${elementType.kind}'`, expr.loc);
        }
        return `{ let ${receiver} = ${receiverExpr}; let ${separatorValue} = ${separator}; runtime::array_join(&${receiver}, &${separatorValue}) }`;
      }
      default:
        this.context.unsupported(`array intrinsic '${expr.method}'`, expr.loc);
    }
  }

  emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "map") this.context.unsupported("map intrinsic on a non-map", expr.loc);
    const type = expr.receiver.type;
    const receiver = this.context.nextTemporary();
    const receiverBinding = `let ${receiver} = ${this.context.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey" || expr.method === "iterValue") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.context.unsupported(`map ${expr.method} without an index`, expr.loc);
      const index = this.context.nextTemporary();
      const helper = expr.method === "iterLive"
        ? "map_iter_live"
        : expr.method === "iterKey" ? "map_iter_key" : "map_iter_value";
      return `{ ${receiverBinding} let ${index} = ${this.context.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    const keyExpr = expr.args[0];
    if (keyExpr === undefined) this.context.unsupported(`map ${expr.method} without a key`, expr.loc);
    const key = this.context.nextTemporary();
    const equality = this.context.mapKeyEquality("left", "right", type.key, expr.loc);
    const bindings = `${receiverBinding} let ${key} = ${this.context.emitExpr(keyExpr)};`;
    switch (expr.method) {
      case "set": {
        const valueExpr = expr.args[1];
        if (valueExpr === undefined) this.context.unsupported("map set without a value", expr.loc);
        const value = this.context.nextTemporary();
        return `{ ${bindings} let ${value} = ${this.context.emitExpr(valueExpr)}; runtime::map_set_by(&${receiver}, ${this.context.mapStoredKey(key, type.key)}, ${value}, |left, right| ${equality}) }`;
      }
      case "get": {
        if (expr.type.kind !== "union") this.context.unsupported("map get without an optional result union", expr.loc);
        const union = this.context.union(expr.type.unionId, expr.loc);
        const undefinedTag = union.arms.findIndex((arm) => arm.kind === "undefinedT");
        if (undefinedTag < 0) this.context.unsupported("map get result union shape", expr.loc);
        const name = this.context.unionName(union.id);
        let present: string;
        if (type.value.kind === "union") {
          if (type.value.unionId === union.id) {
            present = "value";
          } else {
            const stored = this.context.union(type.value.unionId, expr.loc);
            const arms = stored.arms.map((arm, tag) => {
              const resultTag = union.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
              if (resultTag < 0) this.context.unsupported("map get union retag", expr.loc);
              const from = `${this.context.unionName(stored.id)}::${this.context.unionVariant(tag)}`;
              const to = `${name}::${this.context.unionVariant(resultTag)}`;
              return this.context.isUnit(arm) ? `${from} => ${to}` : `${from}(payload) => ${to}(payload)`;
            }).join(", ");
            present = `match value { ${arms} }`;
          }
        } else {
          const valueTag = union.arms.findIndex((arm) => typeKey(arm) === typeKey(type.value));
          if (valueTag < 0) this.context.unsupported("map get result union shape", expr.loc);
          present = `${name}::${this.context.unionVariant(valueTag)}(value)`;
        }
        return `{ ${bindings} match runtime::map_get_by(&${receiver}, &${key}, |left, right| ${equality}) { Some(value) => ${present}, None => ${name}::${this.context.unionVariant(undefinedTag)}, } }`;
      }
      case "has":
        return `{ ${bindings} runtime::map_has_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::map_delete_by(&${receiver}, &${key}, |left, right| ${equality}) }`;
      default:
        this.context.unsupported(`map intrinsic '${expr.method}'`, expr.loc);
    }
  }

  emitMapIntrinsicValues(
    expr: Extract<IrExpr, { kind: "mapIntrinsic" }>,
    receiver: string,
    args: readonly string[],
  ): string {
    if (expr.receiver.type.kind !== "map") this.context.unsupported("async map intrinsic on a non-map", expr.loc);
    if (expr.method !== "set" || args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      this.context.unsupported(`async map intrinsic '${expr.method}'`, expr.loc);
    }
    const equality = this.context.mapKeyEquality("left", "right", expr.receiver.type.key, expr.loc);
    return `runtime::map_set_by(&(${receiver}), ${this.context.mapStoredKey(args[0], expr.receiver.type.key)}, ${args[1]}, |left, right| ${equality})`;
  }

  emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string {
    if (expr.receiver.type.kind !== "set") this.context.unsupported("set intrinsic on a non-set", expr.loc);
    const type = expr.receiver.type;
    const receiver = this.context.nextTemporary();
    const receiverBinding = `let ${receiver} = ${this.context.emitExpr(expr.receiver)};`;
    if (expr.method === "size") return `{ ${receiverBinding} runtime::map_size(&${receiver}) }`;
    if (expr.method === "clear") return `{ ${receiverBinding} runtime::map_clear(&${receiver}) }`;
    if (expr.method === "iterCount") return `{ ${receiverBinding} runtime::map_iter_count(&${receiver}) }`;
    if (expr.method === "iterEnter") return `{ ${receiverBinding} runtime::map_iter_enter(&${receiver}) }`;
    if (expr.method === "iterExit") return `{ ${receiverBinding} runtime::map_iter_exit(&${receiver}) }`;
    if (expr.method === "iterLive" || expr.method === "iterKey") {
      const indexExpr = expr.args[0];
      if (indexExpr === undefined) this.context.unsupported(`set ${expr.method} without an index`, expr.loc);
      const index = this.context.nextTemporary();
      const helper = expr.method === "iterLive" ? "map_iter_live" : "map_iter_key";
      return `{ ${receiverBinding} let ${index} = ${this.context.emitExpr(indexExpr)}; runtime::${helper}(&${receiver}, ${index}) }`;
    }
    if (expr.method === "toArray") return `{ ${receiverBinding} runtime::set_to_array(&${receiver}) }`;
    const valueExpr = expr.args[0];
    if (valueExpr === undefined) this.context.unsupported(`set ${expr.method} without a value`, expr.loc);
    const value = this.context.nextTemporary();
    const equality = this.context.mapKeyEquality("left", "right", type.elem, expr.loc);
    const bindings = `${receiverBinding} let ${value} = ${this.context.emitExpr(valueExpr)};`;
    switch (expr.method) {
      case "add":
        return `{ ${bindings} runtime::set_add_by(&${receiver}, ${this.context.mapStoredKey(value, type.elem)}, |left, right| ${equality}) }`;
      case "has":
        return `{ ${bindings} runtime::set_has_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      case "delete":
        return `{ ${bindings} runtime::set_delete_by(&${receiver}, &${value}, |left, right| ${equality}) }`;
      default:
        this.context.unsupported(`set intrinsic '${expr.method}'`, expr.loc);
    }
  }

}
