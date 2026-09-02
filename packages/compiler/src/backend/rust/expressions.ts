import type { IrClassDef, IrExpr, IrFfiImport, IrFunction, IrLibCallback, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_ERROR_CLASSES, typeEquals, typeKey } from "../../ir/nodes.js";
import { mangleField, mangleFunction, mangleRecordStruct } from "../mangle.js";
import { emitRustLibCall } from "./lib-calls.js";
import { emitRustGeneratorResume } from "./generators.js";
import { emitRustDataViewIntrinsic } from "./data-view.js";
import { emitRustBytesFillIntrinsic } from "./bytes-fill.js";
import { emitRustBytesBasicIntrinsic } from "./bytes-basic.js";
import { emitRustDynamicCall } from "./dynamic-call.js";
import { emitRustDynamicDestructureCheck } from "./dynamic-destructuring.js";
import { emitRustRecordKeyGet } from "./indexed-records.js";
import type { IrFuncType, RustClassMeta, RustClosureShape, RustVtSlot } from "./model.js";
import { emitRustOptionalChain } from "./optional-chains.js";
import { emitRustNullish } from "./nullish.js";
import { RUST_RECORD_OVERFLOW } from "./record-layout.js";
import { emitRustUnionKeyGet } from "./union-key-get.js";
import { emitRustIslandExpr } from "./island.js";
import { emitRustArrayNewLen } from "./array-new-len.js";
import { emitRustFfiCall } from "./ffi.js";
export interface RustExpressionContext {
  readonly chainValues: Map<string, string>;
  readonly classMeta: ReadonlyMap<string, RustClassMeta>;
  readonly closureShapes: ReadonlyMap<string, RustClosureShape>;
  readonly dynBoxedFunctionShapes: ReadonlySet<string>;
  readonly functions: ReadonlyMap<string, IrFunction>;
  ffiImports(): readonly IrFfiImport[];
  libraryCallbacks(): readonly IrLibCallback[];
  readonly records: ReadonlyMap<string, IrRecordShape>;
  nextName(prefix: string): string;
  currentFunction(): IrFunction | null;
  emitSequence(statements: readonly IrStmt[], emitResult: () => string): string;
  assignmentExpr(id: string, value: string, loc: SrcLoc): string;
  classAllocation(meta: RustClassMeta, args: readonly string[], loc: SrcLoc): string;
  classDef(name: string, loc?: SrcLoc): IrClassDef;
  classFieldName(className: string, fieldName: string, loc?: SrcLoc): string;
  classFieldStorageName(owner: RustClassMeta, fieldName: string): string;
  classMetaOf(name: string, loc?: SrcLoc): RustClassMeta;
  classStructName(name: string, loc?: SrcLoc): string;
  classSubtree(meta: RustClassMeta): RustClassMeta[];
  closureName(shape: RustClosureShape): string;
  closureShapeForType(type: IrFuncType, loc?: SrcLoc): RustClosureShape;
  defaultValue(type: IrType, loc: SrcLoc): string;
  displayExpr(expr: IrExpr): string;
  dynFunctionVariant(shape: RustClosureShape): string;
  dynTypeName(): string;
  emitArrayIntrinsic(expr: Extract<IrExpr, { kind: "arrIntrinsic" }>): string;
  emitBinary(expr: Extract<IrExpr, { kind: "bin" }>): string;
  emitBytesNewValue(expr: Extract<IrExpr, { kind: "bytesNew" }>, source: string | null): string;
  emitCallValue(expr: Extract<IrExpr, { kind: "callValue" }>): string;
  emitClosure(expr: Extract<IrExpr, { kind: "closure" }>): string;
  emitClosureDispatch(callee: string, type: IrFuncType, args: string[], loc: SrcLoc): string;
  emitEventEmitterCall(expr: Extract<IrExpr, { kind: "libCall" }>): string | null;
  emitEventEmitterUpcast(value: string, source: IrType, loc: SrcLoc): string | null;
  emitEventEmitterDowncast(value: string, source: IrType, target: IrType, loc: SrcLoc): string | null;
  emitEventEmitterInstanceOf(value: string, source: IrType, target: string, loc: SrcLoc): string | null;
  emitDynCheckValue(type: IrType, value: string, loc?: SrcLoc): string;
  emitDynFromValue(type: IrType, value: string, loc?: SrcLoc, functionName?: string, liveRef?: boolean): string;
  emitFileHandleTransferPromise(expr: Extract<IrExpr, { kind: "libCall" }>): string;
  emitFsRenameCallback(expr: Extract<IrExpr, { kind: "libCall" }>): string;
  emitMapIntrinsic(expr: Extract<IrExpr, { kind: "mapIntrinsic" }>): string;
  emitOrDefault(expr: Extract<IrExpr, { kind: "orDefault" }>): string;
  emitPromiseFromSync(args: readonly IrExpr[], operation: (value: (index: number) => string) => string): string;
  emitPromiseRaceValue(from: IrType, to: IrType, value: string, loc: SrcLoc): string;
  emitRead(id: string, type: IrType, loc: SrcLoc): string;
  emitRecordCloneInitial(expr: Extract<IrExpr, { kind: "recordClone" }>, source: string): string;
  emitRecordCloneOverride(expr: Extract<IrExpr, { kind: "recordClone" }>, clone: string, name: string, value: string): string;
  emitSetIntrinsic(expr: Extract<IrExpr, { kind: "setIntrinsic" }>): string;
  emitStatements(statements: readonly IrStmt[]): void;
  emitToStringValue(type: IrType, operand: string, loc: SrcLoc): string;
  errorClassRoots(): RustClassMeta[];
  errorValueName(): string;
  errorValueVariant(meta: RustClassMeta): string;
  hierarchyFields(root: RustClassMeta): { owner: RustClassMeta; field: IrClassDef["fields"][number] }[];
  hasEmbeddedModules(): boolean;
  isEdgeValue(type: IrType): boolean;
  isRustJsonCompatible(type: IrType, visiting?: Set<string>): boolean;
  isUnit(type: IrType): boolean;
  mapKeyEquality(left: string, right: string, type: IrType, loc: SrcLoc): string;
  mapStoredKey(value: string, type: IrType): string;
  needsClone(type: IrType): boolean;
  numberLiteral(value: number): string;
  promiseRejectorVariant(type: IrFuncType, promiseType: IrType, loc?: SrcLoc): string;
  runtimeErrorAncestor(name: string): string | null;
  runtimeErrorIsA(source: string, target: string): boolean;
  rustString(value: string): string;
  rustType(type: IrType, loc?: SrcLoc): string;
  stripCasts(expr: IrExpr): IrExpr;
  truthiness(value: string, type: IrType, loc: SrcLoc): string;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionEqName(id: string): string;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
  virtualImplementation(meta: RustClassMeta, slot: RustVtSlot): IrFunction;
}

export class RustExpressionEmitter {
  private replacements: ReadonlyMap<IrExpr, string> | null = null;

  constructor(private readonly context: RustExpressionContext) {}

  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string {
    const previous = this.replacements;
    this.replacements = new Map([...(previous ?? []), ...values]);
    try {
      return this.emitExpr(expr);
    } finally {
      this.replacements = previous;
    }
  }

  emitExpr(expr: IrExpr): string {
    const replacement = this.replacements?.get(expr);
    if (replacement !== undefined) return replacement;
    switch (expr.kind) {
      case "numLit":
        return this.context.numberLiteral(expr.value);
      case "strLit":
        return `runtime::string("${this.context.rustString(expr.value)}")`;
      case "regexLit":
        return `runtime::regex_new("${this.context.rustString(expr.pattern)}", "${this.context.rustString(expr.flags)}")`;
      case "templateStrings": {
        const cooked = expr.cooked.map((value) => `"${this.context.rustString(value)}"`).join(", ");
        return `runtime::template_strings("${this.context.rustString(expr.key)}", &[${cooked}])`;
      }
      case "boolLit":
        return expr.value ? "true" : "false";
      case "unitLit":
        return "()";
      case "varRef":
        return this.context.emitRead(expr.localId, expr.type, expr.loc);
      case "bin":
        return this.context.emitBinary(expr);
      case "unary": {
        const operand = this.emitExpr(expr.operand);
        if (expr.op === "-") return `(-(${operand}))`;
        if (expr.op === "!") return `(!(${operand}))`;
        return `runtime::bit_not(${operand})`;
      }
      case "logical": {
        const temp = this.context.nextName("sc_rt");
        const left = this.emitExpr(expr.left);
        const truthy = this.context.truthiness(temp, expr.left.type, expr.loc);
        const takeRight = expr.op === "&&" ? truthy : `!(${truthy})`;
        return `{ let ${temp} = ${left}; if ${takeRight} { ${this.emitExpr(expr.right)} } else { ${temp} } }`;
      }
      case "orDefault":
        return this.context.emitOrDefault(expr);
      case "nullish": return emitRustNullish(expr, this.context, (value) => this.emitExpr(value));
      case "optChain":
        return emitRustOptionalChain(expr, this.context, (value) => this.emitExpr(value));
      case "chainRecv": {
        const value = this.context.chainValues.get(expr.id);
        if (value === undefined) this.context.unsupported(`optional-chain receiver '${expr.id}' outside its body`, expr.loc);
        return this.context.needsClone(expr.type) ? `${value}.clone()` : value;
      }
      case "toBool": {
        const operand = this.emitExpr(expr.operand);
        const temp = this.context.nextName("sc_rt");
        return `{ let ${temp} = ${operand}; ${this.context.truthiness(temp, expr.operand.type, expr.loc)} }`;
      }
      case "strConcat":
        return `runtime::string_concat(&(${this.emitExpr(expr.left)}), &(${this.emitExpr(expr.right)}))`;
      case "strIntrinsic":
        if (expr.method === "length") return `runtime::string_len(&(${this.emitExpr(expr.receiver)}))`;
        if (expr.method === "toLowerCase" && expr.args.length === 0) {
          return `runtime::string_to_lower_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "toUpperCase" && expr.args.length === 0) {
          return `runtime::string_to_upper_case(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "isWellFormed" && expr.args.length === 0) {
          return `runtime::string_is_well_formed(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "toWellFormed" && expr.args.length === 0) {
          return `runtime::string_to_well_formed(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "cpAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_code_point_at_string(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "charAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "at" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "charCodeAt" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_char_code_at(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if (expr.method === "repeat" && expr.args.length === 1 && expr.args[0] !== undefined) {
          return `runtime::string_repeat(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])})`;
        }
        if ((expr.method === "padStart" || expr.method === "padEnd") && expr.args.length === 2 && expr.args[0] !== undefined && expr.args[1] !== undefined) {
          return `runtime::string_${expr.method === "padStart" ? "pad_start" : "pad_end"}(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])}, &(${this.emitExpr(expr.args[1])}))`;
        }
        if ((expr.method === "replace" || expr.method === "replaceAll") && expr.args.length === 2 && expr.args[0] !== undefined && expr.args[1] !== undefined) {
          return `runtime::string_${expr.method === "replace" ? "replace" : "replace_all"}(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), &(${this.emitExpr(expr.args[1])}))`;
        }
        if ((expr.method === "indexOf" || expr.method === "includes") && expr.args[0] !== undefined) {
          const index = `runtime::string_index_of(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1])})`;
          return expr.method === "includes" ? `(${index} >= 0.0)` : index;
        }
        if (expr.method === "startsWith" && expr.args.length >= 1 && expr.args.length <= 2 && expr.args[0] !== undefined) {
          return `runtime::string_starts_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${expr.args[1] === undefined ? "0.0" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "endsWith" && expr.args.length >= 1 && expr.args.length <= 2 && expr.args[0] !== undefined) {
          return `runtime::string_ends_with(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "slice") {
          return `runtime::string_slice(&(${this.emitExpr(expr.receiver)}), ${expr.args[0] === undefined ? "0.0" : this.emitExpr(expr.args[0])}, ${expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "substring" && expr.args[0] !== undefined) {
          return `runtime::string_substring(&(${this.emitExpr(expr.receiver)}), ${this.emitExpr(expr.args[0])}, ${expr.args[1] === undefined ? "f64::INFINITY" : this.emitExpr(expr.args[1])})`;
        }
        if (expr.method === "trim" && expr.args.length === 0) {
          return `runtime::string_trim(&(${this.emitExpr(expr.receiver)}))`;
        }
        if ((expr.method === "trimStart" || expr.method === "trimEnd") && expr.args.length === 0) {
          return `runtime::string_${expr.method === "trimStart" ? "trim_start" : "trim_end"}(&(${this.emitExpr(expr.receiver)}))`;
        }
        if (expr.method === "split" && expr.args.length === 2 && expr.args[0] !== undefined && expr.args[1] !== undefined) {
          return `runtime::string_split(&(${this.emitExpr(expr.receiver)}), &(${this.emitExpr(expr.args[0])}), ${this.emitExpr(expr.args[1])})`;
        }
        this.context.unsupported(`string intrinsic '${expr.method}'`, expr.loc);
      case "regexIntrinsic": {
        const receiver = this.context.nextName("sc_rt");
        const args = expr.args.map(() => this.context.nextName("sc_rt"));
        const bindings = [
          `let ${receiver} = ${this.emitExpr(expr.receiver)};`,
          ...expr.args.map((argument, index) => `let ${args[index]} = ${this.emitExpr(argument)};`),
        ].join(" ");
        if (expr.method === "match" && args.length === 1) {
          if (expr.type.kind !== "union") this.context.unsupported("regex match result without a union", expr.loc);
          const union = this.context.union(expr.type.unionId, expr.loc);
          const arrayTag = union.arms.findIndex((arm) => arm.kind === "array");
          const nullTag = union.arms.findIndex((arm) => arm.kind === "nullT");
          if (arrayTag < 0 || nullTag < 0) this.context.unsupported("regex match result union shape", expr.loc);
          const name = this.context.unionName(union.id);
          return `{ ${bindings} match runtime::regex_match(&${receiver}, &${args[0]}) { Some(value) => ${name}::${this.context.unionVariant(arrayTag)}(value), None => ${name}::${this.context.unionVariant(nullTag)}, } }`;
        }
        if ((expr.method === "matchAll" || expr.method === "matchAllInto") && args.length === (expr.method === "matchAll" ? 1 : 2)) {
          return `{ ${bindings} runtime::regex_${expr.method === "matchAll" ? "match_all" : "match_all_into"}(&${receiver}, &${args[0]}${expr.method === "matchAllInto" ? `, &${args[1]}` : ""}) }`;
        }
        if (expr.method === "search" && args.length === 1) {
          return `{ ${bindings} runtime::regex_search(&${receiver}, &${args[0]}) }`;
        }
        if ((expr.method === "replace" || expr.method === "replaceAll") && args.length === 2) {
          return `{ ${bindings} runtime::regex_${expr.method === "replace" ? "replace" : "replace_all"}(&${receiver}, &${args[0]}, &${args[1]}) }`;
        }
        if (expr.method === "split" && args.length === 2) {
          return `{ ${bindings} runtime::regex_split(&${receiver}, &${args[0]}, ${args[1]}) }`;
        }
        if (expr.method === "test" && args.length === 1) {
          return `{ ${bindings} runtime::regex_test(&${receiver}, &${args[0]}) }`;
        }
        if (expr.method === "source" && args.length === 0) {
          return `{ ${bindings} runtime::regex_source(&${receiver}) }`;
        }
        if (expr.method === "flags" && args.length === 0) {
          return `{ ${bindings} runtime::regex_flags(&${receiver}) }`;
        }
        this.context.unsupported(`regex intrinsic '${expr.method}'`, expr.loc);
      }
      case "strEq": {
        const compare = `(${this.emitExpr(expr.left)}).as_ref() == (${this.emitExpr(expr.right)}).as_ref()`;
        return expr.negated ? `!(${compare})` : `(${compare})`;
      }
      case "strCmp": {
        if (expr.utf16) {
          return `(runtime::string_compare_utf16(&(${this.emitExpr(expr.left)}), &(${this.emitExpr(expr.right)})) ${expr.op} 0)`;
        }
        return `((${this.emitExpr(expr.left)}).as_ref() ${expr.op} (${this.emitExpr(expr.right)}).as_ref())`;
      }
      case "toString": {
        return this.context.emitToStringValue(expr.operand.type, this.emitExpr(expr.operand), expr.loc);
      }
      case "jsonStringify": {
        const value = this.emitExpr(expr.value);
        const indexedDynRecord = expr.value.type.kind === "record" &&
          this.context.records.get(expr.value.type.shapeId)?.indexValue?.kind === "dyn" &&
          this.context.records.get(expr.value.type.shapeId)?.fields.length === 0;
        if (expr.value.type.kind !== "dyn" && !indexedDynRecord && !this.context.isRustJsonCompatible(expr.value.type)) {
          this.context.unsupported(`JSON.stringify value '${expr.value.type.kind}'`, expr.loc);
        }
        const indent = (expr as typeof expr & { indent?: string }).indent;
        return indent
          ? `runtime::json_stringify_indented(&(${value}), "${this.context.rustString(indent)}")`
          : `runtime::json_stringify(&(${value}))`;
      }
      case "dynArrLit": {
        const array = this.context.nextName("sc_rt");
        const values = expr.elems.map((element) => `runtime::array_push(&${array}, ${this.emitExpr(element)});`).join(" ");
        return `{ let ${array}: runtime::JsArray<${this.context.dynTypeName()}> = runtime::array_new(Vec::new()); ${values} ${this.context.dynTypeName()}::Array(${array}) }`;
      }
      case "dynObjLit": {
        const object = this.context.nextName("sc_rt");
        const fields = (expr.fields ?? []).map((field) => {
          if (field.key.type.kind !== "string" || field.value.type.kind !== "dyn") {
            this.context.unsupported("dynamic object field types", expr.loc);
          }
          const key = this.context.nextName("sc_rt");
          const value = this.context.nextName("sc_rt");
          return `let ${key} = ${this.emitExpr(field.key)}; let ${value} = ${this.emitExpr(field.value)}; runtime::map_set_by(&${object}, ${key}, ${value}, |left, right| left.as_ref() == right.as_ref());`;
        }).join(" ");
        return `{ let ${object}: runtime::JsMap<runtime::JsString, ${this.context.dynTypeName()}> = runtime::map_new(); ${fields} ${this.context.dynTypeName()}::Object(${object}) }`;
      }
      case "dynFrom":
        return this.context.emitDynFromValue(expr.value.type, this.emitExpr(expr.value), expr.loc, expr.fnName ?? "", expr.liveRef === true);
      case "dynFromJsval":
        return this.emitExpr(expr.value);
      case "dynCall":
        return emitRustDynamicCall(expr, {
          dynTypeName: () => this.context.dynTypeName(),
          emitExpr: (value) => this.emitExpr(value),
          nextName: (prefix) => this.context.nextName(prefix),
          rustString: (value) => this.context.rustString(value),
        });
      case "dynInvoke": {
        const receiver = this.context.nextName("sc_rt");
        const args = this.context.nextName("sc_rt");
        const values = expr.args.map((arg) => this.emitExpr(arg)).join(", ");
        return `{ let ${receiver} = ${this.emitExpr(expr.recv)}; let ${args} = [${values}]; sc_dyn_invoke(&${receiver}, "${this.context.rustString(expr.method)}", &${args}, "${this.context.rustString(expr.calleeName)}") }`;
      }
      case "dynIterN": {
        if (expr.value.type.kind !== "dyn" && expr.value.type.kind !== "jsval") this.context.unsupported("dynamic iteration value", expr.loc);
        return `sc_dyn_iter_n(&(${this.emitExpr(expr.value)}), ${expr.count})`;
      }
      case "dynDestrCheck":
        return emitRustDynamicDestructureCheck(expr, this.context, (value) => this.emitExpr(value));
      case "dynTest": {
        const value = this.context.nextName("sc_rt");
        const name = this.context.dynTypeName();
        const functions = [...this.context.dynBoxedFunctionShapes].map((key) => {
          const shape = this.context.closureShapes.get(key);
          if (shape === undefined) this.context.unsupported(`dynamic function signature '${key}'`, expr.loc);
          return `${name}::${this.context.dynFunctionVariant(shape)}(..)`;
        });
        let test: string;
        switch (expr.test) {
          case "number": test = `matches!(&${value}, ${name}::Number(..))`; break;
          case "integer": test = `matches!(&${value}, ${name}::Number(number) if runtime::number_is_integer(*number))`; break;
          case "boolean": test = `matches!(&${value}, ${name}::Boolean(..))`; break;
          case "string": test = `matches!(&${value}, ${name}::String(..))`; break;
          case "undefined": test = `matches!(&${value}, ${name}::Undefined)`; break;
          case "null": test = `matches!(&${value}, ${name}::Null)`; break;
          case "nullish": test = `matches!(&${value}, ${name}::Undefined | ${name}::Null)`; break;
          case "function": test = `matches!(&${value}, ${name}::NativeConstructor(..)${functions.length === 0 ? "" : ` | ${functions.join(" | ")}`})`; break;
          case "object": test = `matches!(&${value}, ${name}::Null | ${name}::Bytes(..) | ${name}::TypedBytes(..) | ${name}::Buffer(..) | ${name}::Array(..) | ${name}::Object(..) | ${name}::Url(..) | ${name}::Promise(..) | ${name}::NetServer(..) | ${name}::NetSocket(..) | ${name}::HttpRequest(..) | ${name}::HttpHeaders(..) | ${name}::HttpResponse(..) | ${name}::HttpAgent(..))`; break;
          case "array": test = `matches!(&${value}, ${name}::Array(..))`; break;
          case "error": test = `match &${value} { ${name}::Object(object) => runtime::map_has_by(object, &runtime::string("%error"), |left, right| left.as_ref() == right.as_ref()), _ => false }`; break;
          case "bytes": test = `matches!(&${value}, ${name}::Bytes(..) | ${name}::TypedBytes(..) | ${name}::Buffer(..))`; break;
          case "truthy":
            test = `match &${value} { ${name}::Undefined | ${name}::Null => false, ${name}::Number(value) => *value != 0.0 && !value.is_nan(), ${name}::Boolean(value) => *value, ${name}::String(value) => !value.is_empty(), _ => true }`;
            break;
        }
        if (expr.negated) test = `!(${test})`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; ${test} }`;
      }
      case "dynKeyGet": {
        if (expr.key.type.kind !== "string") this.context.unsupported("dynamic keyed read with a non-string key", expr.loc);
        const value = this.context.nextName("sc_rt");
        const key = this.context.nextName("sc_rt");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; let ${key} = ${this.emitExpr(expr.key)}; sc_dyn_key_get(&${value}, &${key}, ${expr.optional === true ? "true" : "false"}) }`;
      }
      case "dynHasKey": {
        const value = this.context.nextName("sc_rt");
        const index = /^(?:0|[1-9][0-9]*)$/u.test(expr.key) && Number.isSafeInteger(Number(expr.key))
          ? Number(expr.key)
          : null;
        const arrayTest = expr.key === "length"
          ? "true"
          : index === null ? "false" : `runtime::array_len(array) > ${index}.0`;
        const test = `match &${value} { ${this.context.dynTypeName()}::Object(object) => runtime::map_has_by(object, &runtime::string("${this.context.rustString(expr.key)}"), |left, right| left.as_ref() == right.as_ref()), ${this.context.dynTypeName()}::Array(array) => ${arrayTest}, _ => false, }`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; ${expr.negated === true ? `!(${test})` : test} }`;
      }
      case "dynScalarEq": {
        const left = this.context.nextName("sc_rt");
        const right = this.context.nextName("sc_rt");
        let test: string;
        if (expr.left.type.kind === "dyn" && expr.right.type.kind === "dyn") {
          test = `sc_dyn_strict_equal(&${left}, &${right})`;
        } else {
          const dynamic = expr.left.type.kind === "dyn" ? left : right;
          const scalar = expr.left.type.kind === "dyn" ? right : left;
          const scalarType = expr.left.type.kind === "dyn" ? expr.right.type : expr.left.type;
          const name = this.context.dynTypeName();
          if (scalarType.kind === "string") {
            test = `match &${dynamic} { ${name}::String(value) => value.as_ref() == ${scalar}.as_ref(), _ => false, }`;
          } else if (scalarType.kind === "f64") {
            test = `match &${dynamic} { ${name}::Number(value) => *value == ${scalar}, _ => false, }`;
          } else if (scalarType.kind === "bool") {
            test = `match &${dynamic} { ${name}::Boolean(value) => *value == ${scalar}, _ => false, }`;
          } else {
            this.context.unsupported(`dynamic scalar equality with '${scalarType.kind}'`, expr.loc);
          }
        }
        return `{ let ${left} = ${this.emitExpr(expr.left)}; let ${right} = ${this.emitExpr(expr.right)}; ${expr.negated === true ? `!(${test})` : test} }`;
      }
      case "dynCheck": {
        if (expr.value.kind === "libCall" && expr.value.fn === "json.parse" && expr.value.args.length === 1) {
          const text = expr.value.args[0];
          if (text === undefined || text.type.kind !== "string") {
            this.context.unsupported(`JSON.parse target '${expr.type.kind}'`, expr.loc);
          }
          if (expr.type.kind === "record") {
            const shape = this.context.records.get(expr.type.shapeId);
            if (shape?.indexValue?.kind === "dyn" && shape.fields.length === 0) {
              const parsed = `runtime::json_parse_typed::<${this.context.dynTypeName()}>(&(${this.emitExpr(text)}))`;
              return this.context.emitDynCheckValue(expr.type, parsed, expr.loc);
            }
          }
          if (!this.context.isRustJsonCompatible(expr.type)) {
            this.context.unsupported(`JSON.parse target '${expr.type.kind}'`, expr.loc);
          }
          return `runtime::json_parse_typed::<${this.context.rustType(expr.type, expr.loc)}>(&(${this.emitExpr(text)}))`;
        }
        return this.context.emitDynCheckValue(expr.type, this.emitExpr(expr.value), expr.loc);
      }
      case "ternary":
        return `(if ${this.emitExpr(expr.cond)} { ${this.emitExpr(expr.then)} } else { ${this.emitExpr(expr.else_)} })`;
      case "arrayLit": {
        if (expr.type.kind !== "array") this.context.unsupported("array literal with a non-array type", expr.loc);
        const array = this.context.nextName("sc_rt");
        const spreadSet = new Set(expr.spreads ?? []);
        const operations = expr.elems.map((element, index) => spreadSet.has(index)
          ? `runtime::array_extend(&${array}, &(${this.emitExpr(element)}));`
          : `runtime::array_push(&${array}, ${this.emitExpr(element)});`).join(" ");
        return `{ let ${array}: ${this.context.rustType(expr.type, expr.loc)} = runtime::array_new(Vec::new()); ${operations} ${array} }`;
      }
      case "arrayNewLen": {
        return emitRustArrayNewLen(expr, this.context, (value) => this.emitExpr(value));
      }
      case "arrayGet":
        if (expr.arr.type.kind !== "array") this.context.unsupported("arrayGet on a non-array", expr.loc);
        return `runtime::array_get(&(${this.emitExpr(expr.arr)}), ${this.emitExpr(expr.index)})`;
      case "arrIntrinsic":
        return this.context.emitArrayIntrinsic(expr);
      case "bytesNew": {
        return this.context.emitBytesNewValue(expr, expr.source === null ? null : this.emitExpr(expr.source));
      }
      case "bytesIntrinsic": {
        if (expr.receiver.type.kind !== "bytes") this.context.unsupported("bytes intrinsic receiver", expr.loc);
        const dataView = emitRustDataViewIntrinsic(expr, { emitExpr: (value) => this.emitExpr(value) });
        if (dataView !== null) return dataView;
        const elementFill = emitRustBytesFillIntrinsic(expr, {
          emitExpr: (value) => this.emitExpr(value),
          nextName: (prefix) => this.context.nextName(prefix),
        });
        if (elementFill !== null) return elementFill;
        if ([
          "equals", "compareBuf", "indexOf", "lastIndexOf", "includes",
          "indexOfNum", "lastIndexOfNum", "includesNum",
          "fill", "fillNum", "fillStr", "copy", "swap16", "swap32", "swap64", "writeStr",
        ].includes(expr.method)) {
          const receiver = this.context.nextName("sc_rt");
          const args = expr.args.map(() => this.context.nextName("sc_rt"));
          const bindings = [
            `let ${receiver} = ${this.emitExpr(expr.receiver)};`,
            ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
          ].join(" ");
          if (expr.method === "equals" && args.length === 1 && args[0] !== undefined) {
            return `{ ${bindings} runtime::bytes_equals(&${receiver}, &${args[0]}) }`;
          }
          if (expr.method === "compareBuf" && args.length >= 1 && args.length <= 5 && args[0] !== undefined) {
            const offsets = [args[1] ?? "0.0", args[2] ?? "0.0", args[3] ?? "0.0", args[4] ?? "0.0"];
            return `{ ${bindings} runtime::bytes_compare(&${receiver}, &${args[0]}, ${args.length - 1}_usize, ${offsets.join(", ")}) }`;
          }
          if ((expr.method === "indexOf" || expr.method === "lastIndexOf" || expr.method === "includes") &&
            args.length >= 2 && args.length <= 3 && args[0] !== undefined && args[1] !== undefined) {
            const call = `runtime::bytes_index_of(&${receiver}, &${args[0]}, ${args[2] ?? "f64::NAN"}, ${args[1]}, ${expr.method !== "lastIndexOf"})`;
            return `{ ${bindings} ${expr.method === "includes" ? `${call} != -1.0` : call} }`;
          }
          if ((expr.method === "indexOfNum" || expr.method === "lastIndexOfNum" || expr.method === "includesNum") &&
            args.length >= 1 && args.length <= 2 && args[0] !== undefined) {
            const call = `runtime::bytes_index_of_num(&${receiver}, ${args[0]}, ${args[1] ?? "f64::NAN"}, ${expr.method !== "lastIndexOfNum"})`;
            return `{ ${bindings} ${expr.method === "includesNum" ? `${call} != -1.0` : call} }`;
          }
          if ((expr.method === "fill" || expr.method === "fillNum") &&
            args.length >= 1 && args.length <= 3 && args[0] !== undefined) {
            const helper = expr.method === "fill" ? "bytes_fill" : "bytes_fill_num";
            const value = expr.method === "fill" ? `&${args[0]}` : args[0];
            return `{ ${bindings} runtime::${helper}(&${receiver}, ${value}, ${args.length - 1}_usize, ${args[1] ?? "0.0"}, ${args[2] ?? "0.0"}) }`;
          }
          if (expr.method === "fillStr" && args.length >= 2 && args.length <= 4 &&
            args[0] !== undefined && args[1] !== undefined) {
            return `{ ${bindings} runtime::bytes_fill_str(&${receiver}, &${args[0]}, &${args[1]}, ${args.length - 2}_usize, ${args[2] ?? "0.0"}, ${args[3] ?? "0.0"}) }`;
          }
          if (expr.method === "copy" && args.length >= 1 && args.length <= 4 && args[0] !== undefined) {
            return `{ ${bindings} runtime::bytes_copy_into(&${receiver}, &${args[0]}, ${args.length - 1}_usize, ${args[1] ?? "0.0"}, ${args[2] ?? "0.0"}, ${args[3] ?? "0.0"}) }`;
          }
          if ((expr.method === "swap16" || expr.method === "swap32" || expr.method === "swap64") && args.length === 0) {
            const width = expr.method === "swap16" ? 2 : expr.method === "swap32" ? 4 : 8;
            return `{ ${bindings} runtime::bytes_swap(&${receiver}, ${width}_usize) }`;
          }
          if (expr.method === "writeStr" && args.length >= 3 && args.length <= 4 &&
            args[0] !== undefined && args[1] !== undefined && args[2] !== undefined) {
            return `{ ${bindings} runtime::bytes_write_str(&${receiver}, &${args[0]}, &${args[1]}, ${args[2]}, ${args[3] ?? "0.0"}, ${args[3] !== undefined}) }`;
          }
          this.context.unsupported(`bytes intrinsic '${expr.method}' arguments`, expr.loc);
        }
        if (expr.method === "readNum" && expr.args.length === 2) {
          const kind = expr.args[0];
          const offset = expr.args[1];
          if (kind?.kind !== "strLit" || offset === undefined) this.context.unsupported("bytes readNum arguments", expr.loc);
          return `runtime::bytes_read_num(&(${this.emitExpr(expr.receiver)}), "${this.context.rustString(kind.value)}", ${this.emitExpr(offset)})`;
        }
        if (expr.method === "writeNum" && expr.args.length === 3) {
          const kind = expr.args[0];
          const value = expr.args[1];
          const offset = expr.args[2];
          if (kind?.kind !== "strLit" || value === undefined || offset === undefined) this.context.unsupported("bytes writeNum arguments", expr.loc);
          return `runtime::bytes_write_num(&(${this.emitExpr(expr.receiver)}), "${this.context.rustString(kind.value)}", ${this.emitExpr(value)}, ${this.emitExpr(offset)})`;
        }
        if (expr.method === "readNumVar" && expr.args.length === 3) {
          const kind = expr.args[0];
          const offsetExpr = expr.args[1];
          const widthExpr = expr.args[2];
          if (kind?.kind !== "strLit" || offsetExpr === undefined || widthExpr === undefined) {
            this.context.unsupported("bytes readNumVar arguments", expr.loc);
          }
          const receiver = this.context.nextName("sc_rt");
          const offset = this.context.nextName("sc_rt");
          const width = this.context.nextName("sc_rt");
          return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; let ${offset} = ${this.emitExpr(offsetExpr)}; let ${width} = ${this.emitExpr(widthExpr)}; runtime::bytes_read_num_var(&${receiver}, "${this.context.rustString(kind.value)}", ${offset}, ${width}) }`;
        }
        if (expr.method === "writeNumVar" && expr.args.length === 4) {
          const kind = expr.args[0];
          const valueExpr = expr.args[1];
          const offsetExpr = expr.args[2];
          const widthExpr = expr.args[3];
          if (kind?.kind !== "strLit" || valueExpr === undefined || offsetExpr === undefined || widthExpr === undefined) {
            this.context.unsupported("bytes writeNumVar arguments", expr.loc);
          }
          const receiver = this.context.nextName("sc_rt");
          const value = this.context.nextName("sc_rt");
          const offset = this.context.nextName("sc_rt");
          const width = this.context.nextName("sc_rt");
          return `{ let ${receiver} = ${this.emitExpr(expr.receiver)}; let ${value} = ${this.emitExpr(valueExpr)}; let ${offset} = ${this.emitExpr(offsetExpr)}; let ${width} = ${this.emitExpr(widthExpr)}; runtime::bytes_write_num_var(&${receiver}, "${this.context.rustString(kind.value)}", ${value}, ${offset}, ${width}) }`;
        }
        const basic = emitRustBytesBasicIntrinsic(expr, {
          emitExpr: (value) => this.emitExpr(value),
          nextName: (prefix) => this.context.nextName(prefix),
        });
        if (basic !== null) return basic;
        if (expr.method === "toStringVar" && expr.args.length >= 1 && expr.args.length <= 3 && expr.args[0] !== undefined) {
          const receiver = this.context.nextName("sc_rt");
          const encoding = this.context.nextName("sc_rt");
          const startExpr = expr.args[1];
          const endExpr = expr.args[2];
          const start = startExpr === undefined ? null : this.context.nextName("sc_rt");
          const end = endExpr === undefined ? null : this.context.nextName("sc_rt");
          const bindings = [
            `let ${receiver} = ${this.emitExpr(expr.receiver)};`,
            `let ${encoding} = ${this.emitExpr(expr.args[0])};`,
            startExpr === undefined ? "" : `let ${start} = ${this.emitExpr(startExpr)};`,
            endExpr === undefined ? "" : `let ${end} = ${this.emitExpr(endExpr)};`,
          ].join(" ");
          if (start === null) {
            return `{ ${bindings} runtime::bytes_to_string_checked(&${receiver}, &${encoding}) }`;
          }
          return `{ ${bindings} runtime::bytes_to_string_checked_range(&${receiver}, &${encoding}, ${start}, ${end ?? `runtime::bytes_len(&${receiver})`}) }`;
        }
        if (expr.method === "toString" && expr.args[0] !== undefined) {
          const encoding = this.emitExpr(expr.args[0]);
          if (expr.args.length === 1) {
            return `runtime::bytes_to_string(&(${this.emitExpr(expr.receiver)}), &(${encoding}))`;
          }
          const start = expr.args[1];
          const end = expr.args[2];
          if (start === undefined || expr.args.length > 3) this.context.unsupported("bytes toString arguments", expr.loc);
          return `runtime::bytes_to_string_range(&(${this.emitExpr(expr.receiver)}), &(${encoding}), ${this.emitExpr(start)}, ${end === undefined ? "f64::INFINITY" : this.emitExpr(end)})`;
        }
        this.context.unsupported(`bytes intrinsic '${expr.method}'`, expr.loc);
      }
      case "mapNew": {
        if (expr.type.kind !== "map") this.context.unsupported("mapNew with a non-map type", expr.loc);
        const type = expr.type;
        const map = this.context.nextName("sc_rt");
        const equality = this.context.mapKeyEquality("left", "right", type.key, expr.loc);
        const entries = (expr.seed ?? []).map(({ key, value }) => {
          const keyTemp = this.context.nextName("sc_rt");
          const valueTemp = this.context.nextName("sc_rt");
          return `let ${keyTemp} = ${this.emitExpr(key)}; let ${valueTemp} = ${this.emitExpr(value)}; runtime::map_set_by(&${map}, ${this.context.mapStoredKey(keyTemp, type.key)}, ${valueTemp}, |left, right| ${equality});`;
        }).join(" ");
        return `{ let ${map}: ${this.context.rustType(expr.type, expr.loc)} = runtime::map_new(); ${entries} ${map} }`;
      }
      case "mapIntrinsic":
        return this.context.emitMapIntrinsic(expr);
      case "setNew": {
        if (expr.type.kind !== "set") this.context.unsupported("setNew with a non-set type", expr.loc);
        const equality = this.context.mapKeyEquality("left", "right", expr.type.elem, expr.loc);
        if (expr.seed === undefined) return `runtime::set_new::<${this.context.rustType(expr.type.elem, expr.loc)}>()`;
        const seed = this.context.nextName("sc_rt");
        const value = "value";
        const normalized = this.context.mapStoredKey(value, expr.type.elem);
        return `{ let ${seed} = ${this.emitExpr(expr.seed)}; runtime::set_from_array_by(&${seed}, |${value}| ${normalized}, |left, right| ${equality}) }`;
      }
      case "setIntrinsic":
        return this.context.emitSetIntrinsic(expr);
      case "recordLit": {
        if (expr.type.kind !== "record") this.context.unsupported("record literal with a non-record type", expr.loc);
        const shape = this.context.records.get(expr.type.shapeId);
        if (shape === undefined) this.context.unsupported(`unknown record shape '${expr.type.shapeId}'`, expr.loc);
        if (shape.indexValue !== undefined && shape.fields.length === 0) {
          const map = this.context.nextName("sc_rt");
          const entries = expr.fields.map((entry) => {
            if (entry.drop) this.context.unsupported("dropped indexed record field", expr.loc);
            const value = this.context.nextName("sc_rt");
            return `let ${value} = ${this.emitExpr(entry.value)}; runtime::map_set_by(&${map}, runtime::string("${this.context.rustString(entry.name)}"), ${value}, |left, right| left.as_ref() == right.as_ref());`;
          }).join(" ");
          return `{ let ${map}: ${this.context.rustType(expr.type, expr.loc)} = runtime::map_new(); ${entries} ${map} }`;
        }
        const values = new Map<string, string>();
        const bindings: string[] = [];
        const indexValue = shape.indexValue;
        let overflow: string | null = null;
        if (indexValue !== undefined) {
          overflow = this.context.nextName("sc_rt");
          const value = indexValue.kind === "dyn"
            ? this.context.dynTypeName()
            : this.context.rustType(indexValue, expr.loc);
          bindings.push(`let ${overflow}: runtime::JsMap<runtime::JsString, ${value}> = runtime::map_new();`);
        }
        for (const entry of expr.fields) {
          const temp = this.context.nextName("sc_rt");
          bindings.push(`let ${temp} = ${this.emitExpr(entry.value)};`);
          if (entry.drop) continue;
          if (entry.overflow) {
            if (overflow === null) this.context.unsupported("record overflow field", expr.loc);
            bindings.push(`runtime::map_set_by(&${overflow}, runtime::string("${this.context.rustString(entry.name)}"), ${temp}, |left, right| left.as_ref() == right.as_ref());`);
          } else {
            values.set(entry.name, temp);
          }
        }
        const fields = shape.fields.map((field) => {
          const value = values.get(field.name);
          if (value === undefined) this.context.unsupported(`missing record field '${shape.id}.${field.name}'`, expr.loc);
          const stored = this.context.isEdgeValue(field.type) ? `Some(${value})` : value;
          return `${mangleField(field.name)}: ${stored}`;
        }).join(", ");
        const overflowField = overflow === null ? "" : `, ${RUST_RECORD_OVERFLOW}: Some(${overflow})`;
        return `{ ${bindings.join(" ")} runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields}${overflowField} }) }`;
      }
      case "recordClone": {
        const source = this.context.nextName("sc_rt");
        const clone = this.context.nextName("sc_rt");
        const overrides = expr.overrides.map((override) => {
          const value = this.context.nextName("sc_rt");
          return `let ${value} = ${this.emitExpr(override.value)}; ${this.context.emitRecordCloneOverride(expr, clone, override.name, value)}`;
        }).join(" ");
        return `{ let ${source} = ${this.emitExpr(expr.source)}; let ${clone} = ${this.context.emitRecordCloneInitial(expr, source)}; ${overrides} ${clone} }`;
      }
      case "recordGet": {
        const shape = this.context.records.get(expr.shapeId);
        const field = shape?.fields.find((candidate) => candidate.name === expr.field);
        if (shape === undefined || field === undefined) this.context.unsupported(`unknown record field '${expr.shapeId}.${expr.field}'`, expr.loc);
        const access = `record.${mangleField(field.name)}`;
        const result = this.context.isEdgeValue(field.type)
          ? `${access}.as_ref().expect("scriptc: cleared live record field").clone()`
          : this.context.needsClone(field.type) ? `${access}.clone()` : access;
        return `(${this.emitExpr(expr.obj)}).with(|record| ${result})`;
      }
      case "recordKeyGet": {
        return emitRustRecordKeyGet(expr, this.context, (value) => this.emitExpr(value));
      }
      case "recordOvfKeys": {
        const shape = this.context.records.get(expr.shapeId);
        if (shape?.indexValue === undefined) {
          this.context.unsupported(`indexed record keys '${expr.shapeId}'`, expr.loc);
        }
        if (shape.fields.length === 0) {
          return `runtime::map_string_keys_js_order(&(${this.emitExpr(expr.obj)}))`;
        }
        const object = this.context.nextName("sc_rt");
        return `{ let ${object} = ${this.emitExpr(expr.obj)}; ${object}.with(|record| runtime::map_string_keys_js_order(record.${RUST_RECORD_OVERFLOW}.as_ref().expect("scriptc: cleared live record overflow"))) }`;
      }
      case "caughtToDyn": {
        const caught = this.context.nextName("sc_rt");
        const error = this.context.nextName("sc_rt");
        const dyn = this.context.dynTypeName();
        const errorTest = this.context.errorClassRoots().length === 0 ? `runtime::caught_is_error(&${caught})` : `sc_caught_is_error_class(&${caught}, "Error")`;
        const errorValue = this.context.errorClassRoots().length === 0 ? `runtime::caught_error_value(&${caught})` : `sc_caught_error_value(&${caught})`;
        return `{ let ${caught} = ${this.emitExpr(expr.value)}; if runtime::caught_is::<${dyn}>(&${caught}) { runtime::caught_narrow::<${dyn}>(&${caught}) } else if runtime::caught_is::<f64>(&${caught}) { ${dyn}::Number(runtime::caught_narrow::<f64>(&${caught})) } else if runtime::caught_is::<bool>(&${caught}) { ${dyn}::Boolean(runtime::caught_narrow::<bool>(&${caught})) } else if runtime::caught_is::<runtime::JsString>(&${caught}) { ${dyn}::String(runtime::caught_narrow::<runtime::JsString>(&${caught})) } else if ${errorTest} { let ${error} = ${errorValue}; sc_dyn_error_box(&${error}) } else { ${dyn}::Object(runtime::map_new()) } }`;
      }
      case "caughtTest":
        if (expr.test !== "instanceof") {
          const type = { string: "runtime::JsString", number: "f64", boolean: "bool" }[expr.test];
          const test = `runtime::caught_is::<${type}>(&(${this.emitExpr(expr.value)}))`;
          return expr.negated ? `!(${test})` : test;
        }
        if (expr.className === undefined) {
          this.context.unsupported(`caught test '${expr.test}:${expr.className ?? ""}'`, expr.loc);
        }
        if (!RUNTIME_ERROR_CLASSES.has(expr.className)) {
          const meta = this.context.classMeta.get(expr.className);
          if (meta === undefined) this.context.unsupported(`caught test '${expr.test}:${expr.className}'`, expr.loc);
          const caught = this.context.nextName("sc_rt");
          const object = this.context.nextName("sc_rt");
          const type = this.context.rustType({ kind: "object", className: meta.def.name }, expr.loc);
          const sameHierarchy = `runtime::caught_is::<${type}>(&${caught})`;
          let test = meta.hierarchy
            ? `${sameHierarchy} && { let ${object} = runtime::caught_narrow::<${type}>(&${caught}); ${object}.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post}) }`
            : sameHierarchy;
          if (this.context.runtimeErrorAncestor(meta.def.name) !== null) {
            const value = this.context.nextName("sc_rt");
            const variant = `${this.context.errorValueName()}::${this.context.errorValueVariant(meta)}`;
            const narrowed = meta.hierarchy
              ? `object.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post})`
              : "true";
            test = `(${test}) || (runtime::caught_is::<${this.context.errorValueName()}>(&${caught}) && { let ${value} = runtime::caught_narrow::<${this.context.errorValueName()}>(&${caught}); match &${value} { ${variant}(object) => ${narrowed}, _ => false, } })`;
          }
          const result = expr.negated ? `!(${test})` : test;
          return `{ let ${caught} = ${this.emitExpr(expr.value)}; ${result} }`;
        }
        {
          const error = RUNTIME_ERROR_CLASSES.get(expr.className);
          if (error === undefined) this.context.unsupported(`caught test '${expr.test}:${expr.className}'`, expr.loc);
          const caught = this.context.nextName("sc_rt");
          if (this.context.errorClassRoots().length > 0) {
            const test = `sc_caught_is_error_class(&${caught}, "${this.context.rustString(error.lib)}")`;
            const result = expr.negated ? `!(${test})` : test;
            return `{ let ${caught} = ${this.emitExpr(expr.value)}; ${result} }`;
          }
          const subclassTests = [...this.context.classMeta.values()]
            .filter((meta) => meta === meta.root && this.context.runtimeErrorAncestor(meta.def.name) !== null)
            .filter((meta) => error.lib === "Error" || this.context.runtimeErrorAncestor(meta.def.name) === expr.className)
            .map((meta) => `runtime::caught_is::<${this.context.rustType({ kind: "object", className: meta.def.name }, expr.loc)}>(&${caught})`);
          const test = [
            `runtime::caught_is_error_class(&${caught}, "${this.context.rustString(error.lib)}")`,
            ...subclassTests,
          ].join(" || ");
          const wrapped = `{ let ${caught} = ${this.emitExpr(expr.value)}; ${test} }`;
          return expr.negated ? `!(${wrapped})` : wrapped;
        }
      case "caughtNarrow":
        if (expr.type.kind === "f64") return `runtime::caught_narrow::<f64>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "bool") return `runtime::caught_narrow::<bool>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "string") return `runtime::caught_narrow::<runtime::JsString>(&(${this.emitExpr(expr.value)}))`;
        if (expr.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.type.className)) {
          const helper = this.context.errorClassRoots().length === 0 ? "runtime::caught_error_value" : "sc_caught_error_value";
          return `${helper}(&(${this.emitExpr(expr.value)}))`;
        }
        if (expr.type.kind === "object" && this.context.classMeta.has(expr.type.className)) {
          const meta = this.context.classMetaOf(expr.type.className, expr.loc);
          const type = this.context.rustType(expr.type, expr.loc);
          if (this.context.runtimeErrorAncestor(meta.def.name) !== null) {
            const caught = this.context.nextName("sc_rt");
            const variant = `${this.context.errorValueName()}::${this.context.errorValueVariant(meta)}`;
            return `{ let ${caught} = ${this.emitExpr(expr.value)}; if runtime::caught_is::<${type}>(&${caught}) { runtime::caught_narrow::<${type}>(&${caught}) } else { match runtime::caught_narrow::<${this.context.errorValueName()}>(&${caught}) { ${variant}(value) => value, _ => unreachable!("scriptc invariant: narrowed caught Error has the wrong subclass"), } } }`;
          }
          return `runtime::caught_narrow::<${type}>(&(${this.emitExpr(expr.value)}))`;
        }
        this.context.unsupported("caught narrowing outside scalar and Error values", expr.loc);
      case "caughtCheck": {
        if (expr.type.kind !== "object") this.context.unsupported("caught check outside an object", expr.loc);
        const error = RUNTIME_ERROR_CLASSES.get(expr.className);
        if (error === undefined) this.context.unsupported(`caught check '${expr.className}'`, expr.loc);
        const helper = this.context.errorClassRoots().length === 0 ? "runtime::caught_check_error" : "sc_caught_check_error";
        return `${helper}(&(${this.emitExpr(expr.value)}), "${this.context.rustString(error.lib)}")`;
      }
      case "fieldGet":
        if (RUNTIME_ERROR_CLASSES.has(expr.className) && (expr.field === "name" || expr.field === "message")) {
          const helper = this.context.errorClassRoots().length === 0 ? `runtime::error_${expr.field}` : `sc_error_${expr.field}`;
          return `${helper}(&(${this.emitExpr(expr.obj)}))`;
        }
        {
          const cls = this.context.classDef(expr.className, expr.loc);
          const field = cls.fields.find((candidate) => candidate.name === expr.field);
          if (field === undefined) this.context.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
          const access = `object.${this.context.classFieldName(expr.className, field.name, expr.loc)}`;
          const result = this.context.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live class field").clone()`
            : this.context.needsClone(field.type) ? `${access}.clone()` : access;
          return `(${this.emitExpr(expr.obj)}).with(|object| ${result})`;
        }
      case "unionWrap": {
        const union = this.context.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.context.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
        if (this.context.isUnit(arm)) {
          return expr.value.type.kind === "void" ? `{ ${this.emitExpr(expr.value)}; ${variant} }` : variant;
        }
        return `${variant}(${this.emitExpr(expr.value)})`;
      }
      case "unionNarrow": {
        const union = this.context.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined || this.context.isUnit(arm)) this.context.unsupported(`invalid union narrow '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = this.context.nextName("sc_rt");
        const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${variant}(payload) => payload, _ => unreachable!("scriptc invariant: invalid union narrowing") } }`;
      }
      case "unionDisc": {
        const union = this.context.union(expr.unionId, expr.loc);
        const value = this.context.nextName("sc_rt");
        const arms = union.arms.map((arm, tag) => {
          if (arm.kind !== "record") this.context.unsupported(`union discriminant arm '${arm.kind}'`, expr.loc);
          const shape = this.context.records.get(arm.shapeId);
          const field = shape?.fields.find((candidate) => candidate.name === expr.field);
          if (shape === undefined || field === undefined) {
            this.context.unsupported(`unknown union discriminant field '${arm.shapeId}.${expr.field}'`, expr.loc);
          }
          const access = `record.${mangleField(field.name)}`;
          const result = this.context.isEdgeValue(field.type)
            ? `${access}.as_ref().expect("scriptc: cleared live union field").clone()`
            : this.context.needsClone(field.type) ? `${access}.clone()` : access;
          return `${this.context.unionName(union.id)}::${this.context.unionVariant(tag)}(payload) => payload.with(|record| ${result})`;
        }).join(", ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; match &${value} { ${arms} } }`;
      }
      case "unionKeyGet":
        return emitRustUnionKeyGet(expr, this.context, (value) => this.emitExpr(value));
      case "unionIsTag": {
        const union = this.context.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm === undefined) this.context.unsupported(`unknown union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        const value = this.context.nextName("sc_rt");
        const pattern = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}${this.context.isUnit(arm) ? "" : "(..)"}`;
        const test = `{ let ${value} = ${this.emitExpr(expr.value)}; matches!(${value}, ${pattern}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "unionEq": {
        const union = this.context.union(expr.unionId, expr.loc);
        const left = this.context.nextName("sc_rt");
        const right = this.context.nextName("sc_rt");
        const test = `{ let ${left} = ${this.emitExpr(expr.left)}; let ${right} = ${this.emitExpr(expr.right)}; ${this.context.unionEqName(union.id)}(&${left}, &${right}, ${expr.sameValue}) }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "unionFuncEq": {
        const union = this.context.union(expr.unionId, expr.loc);
        const arm = union.arms[expr.tag];
        if (arm?.kind !== "func") this.context.unsupported(`invalid function union tag '${expr.unionId}:${expr.tag}'`, expr.loc);
        if (expr.func.type.kind !== "func") this.context.unsupported("union function equality operand", expr.loc);
        const unionValue = this.context.nextName("sc_rt");
        const functionValue = this.context.nextName("sc_rt");
        const variant = `${this.context.unionName(union.id)}::${this.context.unionVariant(expr.tag)}`;
        const unionShape = this.context.closureShapeForType(arm, expr.loc);
        const functionShape = this.context.closureShapeForType(expr.func.type, expr.loc);
        const unionIdentity = `sc_closure_identity_${unionShape.index}(payload)`;
        const functionIdentity = `sc_closure_identity_${functionShape.index}(&${functionValue})`;
        const test = `{ let ${unionValue} = ${this.emitExpr(expr.union)}; let ${functionValue} = ${this.emitExpr(expr.func)}; match &${unionValue} { ${variant}(payload) => ${unionIdentity} == ${functionIdentity}, _ => false, } }`;
        return expr.negated ? `!(${test})` : test;
      }
      case "closure":
        return this.context.emitClosure(expr);
      case "callValue":
        return this.context.emitCallValue(expr);
      case "selfRef": {
        if (this.context.currentFunction()?.captures === undefined) {
          this.context.unsupported("selfRef outside a lifted closure", expr.loc);
        }
        return "sc_self.clone()";
      }
      case "call": {
        const callee = this.context.functions.get(expr.callee);
        if (callee === undefined) this.context.unsupported(`unknown call target '${expr.callee}'`, expr.loc);
        if (callee.captures !== undefined) this.context.unsupported(`direct call to lifted closure '${callee.name}'`, expr.loc);
        return `${mangleFunction(callee.name)}(${expr.args.map((arg) => this.emitExpr(arg)).join(", ")})`;
      }
      case "virtualCall": {
        const meta = this.context.classMetaOf(expr.className, expr.loc);
        const slot = meta.root.slots.find((candidate) =>
          candidate.method === expr.method && candidate.declarer.pre <= meta.pre && meta.pre <= candidate.declarer.post
        );
        if (slot === undefined) this.context.unsupported(`virtual method '${expr.className}.${expr.method}'`, expr.loc);
        const args = expr.args.map(() => this.context.nextName("sc_rt"));
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        const receiver = args[0];
        if (receiver === undefined) this.context.unsupported(`virtual call '${expr.className}.${expr.method}' without receiver`, expr.loc);
        const pre = this.context.nextName("sc_rt");
        const implementations = new Map<string, { fn: IrFunction; tags: number[] }>();
        for (const dynamic of this.context.classMeta.values()) {
          if (dynamic.def.abstract || dynamic.root !== meta.root || dynamic.pre < meta.pre || dynamic.pre > meta.post) continue;
          const implementation = this.context.virtualImplementation(dynamic, slot);
          const entry = implementations.get(implementation.name);
          if (entry === undefined) implementations.set(implementation.name, { fn: implementation, tags: [dynamic.pre] });
          else entry.tags.push(dynamic.pre);
        }
        const callArgs = args.join(", ");
        const arms = [...implementations.values()].map(({ fn, tags }) =>
          `${tags.join(" | ")} => ${mangleFunction(fn.name)}(${callArgs}),`
        ).join(" ");
        return `{ ${bindings} let ${pre} = ${receiver}.with(|object| object.sc_class_pre); match ${pre} { ${arms} _ => unreachable!("scriptc invariant: invalid dynamic class"), } }`;
      }
      case "instanceOf": {
        if (expr.value.type.kind !== "object") this.context.unsupported("instanceof on a non-object", expr.loc);
        const emitterTest = this.context.emitEventEmitterInstanceOf(
          this.emitExpr(expr.value), expr.value.type, expr.className, expr.loc,
        );
        if (emitterTest !== null) return emitterTest;
        const runtimeTarget = RUNTIME_ERROR_CLASSES.get(expr.className);
        if (runtimeTarget !== undefined) {
          const value = this.context.nextName("sc_rt");
          const ancestor = this.context.runtimeErrorAncestor(expr.value.type.className);
          if (ancestor !== null) {
            return `{ let ${value} = ${this.emitExpr(expr.value)}; let _ = ${value}; ${this.context.runtimeErrorIsA(ancestor, expr.className)} }`;
          }
          if (RUNTIME_ERROR_CLASSES.has(expr.value.type.className)) {
            const helper = this.context.errorClassRoots().length === 0 ? "runtime::error_is_class" : "sc_error_is_class";
            return `{ let ${value} = ${this.emitExpr(expr.value)}; ${helper}(&${value}, "${this.context.rustString(runtimeTarget.lib)}") }`;
          }
          return `{ let ${value} = ${this.emitExpr(expr.value)}; let _ = ${value}; false }`;
        }
        if (RUNTIME_ERROR_CLASSES.has(expr.value.type.className)) {
          const target = this.context.classMetaOf(expr.className, expr.loc);
          const value = this.context.nextName("sc_rt");
          const variant = `${this.context.errorValueName()}::${this.context.errorValueVariant(target)}`;
          const test = target.hierarchy
            ? `object.with(|object| ${target.pre} <= object.sc_class_pre && object.sc_class_pre <= ${target.post})`
            : "true";
          return `{ let ${value} = ${this.emitExpr(expr.value)}; match &${value} { ${variant}(object) => ${test}, _ => false, } }`;
        }
        const target = this.context.classMetaOf(expr.className, expr.loc);
        const value = this.context.nextName("sc_rt");
        const test = target.hierarchy
          ? `${value}.with(|object| ${target.pre} <= object.sc_class_pre && object.sc_class_pre <= ${target.post})`
          : "true";
        return `{ let ${value} = ${this.emitExpr(expr.value)}; let _ = ${value}; ${test} }`;
      }
      case "instanceOfValue": {
        if (expr.value.type.kind !== "object" || expr.classValue.type.kind !== "classval") {
          this.context.unsupported("dynamic instanceof operands", expr.loc);
        }
        const value = this.context.nextName("sc_rt");
        const target = this.context.nextName("sc_rt");
        const pre = this.context.nextName("sc_rt");
        const staticTarget = this.context.classMetaOf(expr.classValue.type.className, expr.loc);
        const arms = this.context.classSubtree(staticTarget).map((candidate) =>
          `${candidate.pre} => ${candidate.pre} <= ${pre} && ${pre} <= ${candidate.post},`
        ).join(" ");
        return `{ let ${value} = ${this.emitExpr(expr.value)}; let ${target} = ${this.emitExpr(expr.classValue)}; let ${pre} = ${value}.with(|object| object.sc_class_pre); match ${target} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "classRef":
        return String(this.context.classMetaOf(expr.className, expr.loc).pre);
      case "new": {
        const cls = this.context.classDef(expr.className, expr.loc);
        if (expr.type.kind !== "object" || expr.type.className !== cls.name) {
          this.context.unsupported(`constructor result for '${cls.name}'`, expr.loc);
        }
        const constructor = this.context.functions.get(`%${cls.name}.constructor`);
        if (constructor === undefined) this.context.unsupported(`missing constructor for '${cls.name}'`, expr.loc);
        const meta = this.context.classMetaOf(cls.name, expr.loc);
        const args = expr.args.map(() => this.context.nextName("sc_rt"));
        const bindings = expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`).join(" ");
        return `{ ${bindings} ${this.context.classAllocation(meta, args, expr.loc)} }`;
      }
      case "newValue": {
        if (expr.callee.type.kind !== "classval") this.context.unsupported("newValue with non-class callee", expr.loc);
        const staticMeta = this.context.classMetaOf(expr.callee.type.className, expr.loc);
        const staticConstructor = this.context.functions.get(`%${staticMeta.def.name}.constructor`);
        if (staticConstructor === undefined) {
          this.context.unsupported(`missing constructor for '${staticMeta.def.name}'`, expr.loc);
        }
        const callee = this.context.nextName("sc_rt");
        const args = expr.args.map(() => this.context.nextName("sc_rt"));
        const bindings = [
          `let ${callee} = ${this.emitExpr(expr.callee)};`,
          ...expr.args.map((arg, index) => `let ${args[index]} = ${this.emitExpr(arg)};`),
        ].join(" ");
        const arms = this.context.classSubtree(staticMeta).filter((dynamic) => {
          if (dynamic.def.abstract) return false;
          const constructor = this.context.functions.get(`%${dynamic.def.name}.constructor`);
          return constructor !== undefined && constructor.params.length === staticConstructor.params.length &&
            constructor.params.every((param, index) => {
              const staticParam = staticConstructor.params[index];
              return index === 0 || staticParam !== undefined && typeEquals(param.type, staticParam.type);
            });
        }).map((dynamic) => `${dynamic.pre} => ${this.context.classAllocation(dynamic, args, expr.loc)},`).join(" ");
        return `{ ${bindings} match ${callee} { ${arms} _ => unreachable!("scriptc invariant: invalid class value"), } }`;
      }
      case "upcast":
        if (expr.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.type.className) &&
          expr.value.type.kind === "object" && this.context.classMeta.has(expr.value.type.className)) {
          const meta = this.context.classMetaOf(expr.value.type.className, expr.loc);
          return `${this.context.errorValueName()}::${this.context.errorValueVariant(meta)}(${this.emitExpr(expr.value)})`;
        }
        if (expr.type.kind === "object" && expr.type.className === RUNTIME_EMITTER_CLASS) {
          const converted = this.context.emitEventEmitterUpcast(this.emitExpr(expr.value), expr.value.type, expr.loc);
          if (converted !== null) return converted;
        }
        return this.emitExpr(expr.value);
      case "downcast":
        {
          const converted = this.context.emitEventEmitterDowncast(
            this.emitExpr(expr.value), expr.value.type, expr.type, expr.loc,
          );
          if (converted !== null) return converted;
        }
        if (expr.value.type.kind === "object" && RUNTIME_ERROR_CLASSES.has(expr.value.type.className) &&
          expr.type.kind === "object" && this.context.classMeta.has(expr.type.className)) {
          const meta = this.context.classMetaOf(expr.type.className, expr.loc);
          const value = this.context.nextName("sc_rt");
          const variant = `${this.context.errorValueName()}::${this.context.errorValueVariant(meta)}`;
          const check = meta.hierarchy
            ? `if !object.with(|object| ${meta.pre} <= object.sc_class_pre && object.sc_class_pre <= ${meta.post}) { unreachable!("scriptc invariant: invalid Error subclass downcast"); }`
            : "";
          return `{ let ${value} = ${this.emitExpr(expr.value)}; match ${value} { ${variant}(object) => { ${check} object }, _ => unreachable!("scriptc invariant: invalid Error subclass downcast"), } }`;
        }
        return this.emitExpr(expr.value);
      case "libCall":
        return emitRustLibCall(expr, {
          nextTemporary: () => this.context.nextName("sc_rt"),
          emitExpr: (value) => this.emitExpr(value),
          unsupported: (kind, loc) => this.context.unsupported(kind, loc),
          dynTypeName: () => this.context.dynTypeName(),
          record: (id, loc) => {
            const record = this.context.records.get(id);
            if (record === undefined) this.context.unsupported(`unknown record shape '${id}'`, loc);
            return record;
          },
          union: (id, loc) => this.context.union(id, loc),
          unionName: (id) => this.context.unionName(id),
          unionVariant: (tag) => this.context.unionVariant(tag),
          stripCasts: (value) => this.context.stripCasts(value),
          hasClassMeta: (name) => this.context.classMeta.has(name),
          classFieldName: (className, fieldName, loc) => this.context.classFieldName(className, fieldName, loc),
          hasErrorClassRoots: () => this.context.errorClassRoots().length > 0,
          errorValueName: () => this.context.errorValueName(),
          rustString: (value) => this.context.rustString(value),
          rustType: (type, loc) => this.context.rustType(type, loc),
          emitPromiseFromSync: (args, operation) => this.context.emitPromiseFromSync(args, operation),
          emitFileHandleTransferPromise: (value) => this.context.emitFileHandleTransferPromise(value),
          emitFsRenameCallback: (value) => this.context.emitFsRenameCallback(value),
          emitClosureDispatch: (callee, type, args, loc) => this.context.emitClosureDispatch(callee, type, args, loc),
          functionIdentity: (value, type, loc, borrowed = false) => {
            const shape = this.context.closureShapeForType(type, loc);
            return `sc_closure_identity_${shape.index}(${borrowed ? value : `&${value}`})`;
          },
          emitEventEmitterCall: (value) => this.context.emitEventEmitterCall(value),
          classNameArms: (className, loc) => {
            const meta = this.context.classMetaOf(className, loc);
            return this.context.classSubtree(meta).map((candidate) =>
              `${candidate.pre} => runtime::string("${this.context.rustString(candidate.def.jsName ?? "")}"),`
            ).join(" ");
          },
        });
      case "ffiCall": return emitRustFfiCall(expr, this.context.ffiImports(), this.context.libraryCallbacks(), this.context, (value) => this.emitExpr(value));
      case "genResume": return emitRustGeneratorResume(expr, this.context, (value) => this.emitExpr(value));
      case "awaitExpr":
      case "awaitUnionExpr":
        this.context.unsupported("async suspension outside the Rust state-machine subset", expr.loc);
      case "promiseWithResolvers": {
        if (expr.type.kind !== "record") this.context.unsupported("Promise.withResolvers result shape", expr.loc);
        const record = this.context.records.get(expr.type.shapeId);
        const promiseType = record?.fields.find((field) => field.name === "promise")?.type;
        const resolverType = record?.fields.find((field) => field.name === "resolve")?.type;
        const rejectorType = record?.fields.find((field) => field.name === "reject")?.type;
        if (record === undefined || record.fields.length !== 3 || promiseType?.kind !== "promise" ||
          resolverType?.kind !== "func" || rejectorType?.kind !== "func") {
          this.context.unsupported("Promise.withResolvers record shape", expr.loc);
        }
        const resolverShape = this.context.closureShapeForType(resolverType, expr.loc);
        const rejectorShape = this.context.closureShapeForType(rejectorType, expr.loc);
        const rejectorVariant = this.context.promiseRejectorVariant(rejectorType, promiseType.inner, expr.loc);
        const promise = this.context.nextName("sc_rt");
        const resolver = this.context.nextName("sc_rt");
        const rejector = this.context.nextName("sc_rt");
        const values = new Map([
          ["promise", promise],
          ["resolve", resolver],
          ["reject", rejector],
        ]);
        const fields = record.fields.map((field) => {
          const value = values.get(field.name);
          if (value === undefined) this.context.unsupported(`Promise.withResolvers field '${field.name}'`, expr.loc);
          return `${mangleField(field.name)}: Some(${value})`;
        }).join(", ");
        return `{ let ${promise} = runtime::promise_new::<${this.context.rustType(promiseType.inner, expr.loc)}>(); let ${resolver} = runtime::Gc::new(${this.context.closureName(resolverShape)}::PromiseResolver { promise: Some(${promise}.clone()) }); let ${rejector} = runtime::Gc::new(${this.context.closureName(rejectorShape)}::${rejectorVariant} { promise: Some(${promise}.clone()) }); runtime::Gc::new(${mangleRecordStruct(record.id)} { ${fields} }) }`;
      }
      case "newPromise": {
        if (expr.type.kind !== "promise" || expr.executor.type.kind !== "func") {
          this.context.unsupported("new Promise shape", expr.loc);
        }
        const promise = this.context.nextName("sc_rt");
        const executor = this.context.nextName("sc_rt");
        if (expr.executor.type.params.length === 0) {
          const dispatch = this.context.emitClosureDispatch(executor, expr.executor.type, [], expr.loc);
          return `{ let ${promise} = runtime::promise_new::<${this.context.rustType(expr.type.inner, expr.loc)}>(); let ${executor} = ${this.emitExpr(expr.executor)}; runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
        }
        if (expr.executor.type.params.length > 2) this.context.unsupported("new Promise executor arity", expr.loc);
        const resolverType = expr.executor.type.params[0];
        if (resolverType?.kind !== "func") this.context.unsupported("new Promise resolver shape", expr.loc);
        const shape = this.context.closureShapeForType(resolverType, expr.loc);
        const resolver = this.context.nextName("sc_rt");
        const rejectorType = expr.executor.type.params[1];
        if (rejectorType === undefined) {
          const dispatch = this.context.emitClosureDispatch(executor, expr.executor.type, [resolver], expr.loc);
          return `{ let ${promise} = runtime::promise_new(); let ${executor} = ${this.emitExpr(expr.executor)}; let ${resolver} = runtime::Gc::new(${this.context.closureName(shape)}::PromiseResolver { promise: Some(${promise}.clone()) }); runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
        }
        if (rejectorType.kind !== "func") this.context.unsupported("new Promise rejector shape", expr.loc);
        const rejectorShape = this.context.closureShapeForType(rejectorType, expr.loc);
        const rejectorVariant = this.context.promiseRejectorVariant(rejectorType, expr.type.inner, expr.loc);
        const rejector = this.context.nextName("sc_rt");
        const dispatch = this.context.emitClosureDispatch(executor, expr.executor.type, [resolver, rejector], expr.loc);
        return `{ let ${promise} = runtime::promise_new(); let ${executor} = ${this.emitExpr(expr.executor)}; let ${resolver} = runtime::Gc::new(${this.context.closureName(shape)}::PromiseResolver { promise: Some(${promise}.clone()) }); let ${rejector} = runtime::Gc::new(${this.context.closureName(rejectorShape)}::${rejectorVariant} { promise: Some(${promise}.clone()) }); runtime::promise_run_segment(&${promise}, || { ${dispatch}; }); ${promise} }`;
      }
      case "promiseVoidWiden": return `runtime::promise_map(&(${this.emitExpr(expr.value)}), |_| ())`;
      case "intrinsic":
        if (expr.name === "promise.reject") {
          if (expr.type.kind !== "promise" || expr.args.length !== 1) {
            this.context.unsupported("Promise.reject shape", expr.loc);
          }
          const reason = expr.args[0];
          if (reason === undefined || (reason.type.kind !== "object" && reason.type.kind !== "dyn")) {
            this.context.unsupported("Promise.reject reason outside Error or dynamic values", expr.loc);
          }
          return `runtime::promise_rejected::<${this.context.rustType(expr.type.inner, expr.loc)}>(runtime::caught_value(${this.emitExpr(reason)}))`;
        }
        if (expr.name === "promise.resolve") {
          if (expr.type.kind !== "promise" || expr.args.length > 1) {
            this.context.unsupported("Promise.resolve shape", expr.loc);
          }
          return `runtime::promise_resolved(${expr.args[0] === undefined ? "()" : this.emitExpr(expr.args[0])})`;
        }
        if (expr.name === "promise.all") {
          if (expr.type.kind !== "promise") this.context.unsupported("Promise.all result shape", expr.loc);
          const entries = expr.args[0];
          if (entries === undefined || entries.type.kind !== "array" || entries.type.elem.kind !== "promise") {
            this.context.unsupported("Promise.all argument shape", expr.loc);
          }
          if (expr.type.inner.kind === "void") {
            if (entries.type.elem.inner.kind !== "void") this.context.unsupported("Promise.all void entry shape", expr.loc);
            return `runtime::promise_all_void(&(${this.emitExpr(entries)}))`;
          }
          if (expr.type.inner.kind !== "array" ||
            typeKey(entries.type.elem.inner) !== typeKey(expr.type.inner.elem)) {
            this.context.unsupported("Promise.all with differing Rust value types", expr.loc);
          }
          return `runtime::promise_all(&(${this.emitExpr(entries)}))`;
        }
        if (expr.name === "promise.race") {
          if (expr.type.kind !== "promise") this.context.unsupported("Promise.race result shape", expr.loc);
          const raceInner = expr.type.inner;
          if (expr.args.length === 0 || expr.args.some((arg) => arg.type.kind !== "promise")) {
            this.context.unsupported("Promise.race entry shape", expr.loc);
          }
          const result = this.context.nextName("sc_rt");
          const entries = expr.args.map((arg) => {
            if (arg.type.kind !== "promise") this.context.unsupported("Promise.race entry shape", expr.loc);
            const entry = this.context.nextName("sc_rt");
            const adapted = this.context.emitPromiseRaceValue(arg.type.inner, raceInner, "value", expr.loc);
            return `let ${entry} = ${this.emitExpr(arg)}; runtime::promise_race_add(&${result}, &${entry}, |value| ${adapted});`;
          }).join(" ");
          return `{ let ${result}: runtime::JsPromise<${this.context.rustType(raceInner, expr.loc)}> = runtime::promise_new(); ${entries} ${result} }`;
        }
        if (expr.name !== "console.log" && expr.name !== "console.error") {
          this.context.unsupported(`intrinsic '${expr.name}'`, expr.loc);
        }
        return `runtime::${expr.name === "console.log" ? "console_log" : "console_error"}(&[${expr.args.map((arg) => this.context.displayExpr(arg)).join(", ")}])`;
      case "assignExpr": {
        const value = this.emitExpr(expr.value);
        const temp = this.context.nextName("sc_rt");
        const clone = this.context.needsClone(expr.type) ? `${temp}.clone()` : temp;
        return `{ let ${temp} = ${value}; ${this.context.assignmentExpr(expr.localId, clone, expr.loc)} ${temp} }`;
      }
      case "seqExpr":
        return this.context.emitSequence(expr.stmts, () => this.emitExpr(expr.result));
      case "incDec": {
        const old = this.context.nextName("sc_rt");
        const next = this.context.nextName("sc_rt");
        const read = this.context.emitRead(expr.localId, expr.type, expr.loc);
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        return `{ let ${old} = ${read}; let ${next} = ${old} ${operation} 1.0; ${this.context.assignmentExpr(expr.localId, next, expr.loc)} ${result} }`;
      }
      case "fieldIncDec": {
        const cls = this.context.classDef(expr.className, expr.loc);
        const field = cls.fields.find((candidate) => candidate.name === expr.field);
        if (field === undefined) this.context.unsupported(`unknown class field '${expr.className}.${expr.field}'`, expr.loc);
        const object = this.context.nextName("sc_rt");
        const old = this.context.nextName("sc_rt");
        const next = this.context.nextName("sc_rt");
        const operation = expr.op === "+" ? "+" : "-";
        const result = expr.prefix ? next : old;
        const name = this.context.classFieldName(expr.className, field.name, expr.loc);
        if (expr.fieldDyn) {
          if (field.type.kind !== "dyn") {
            this.context.unsupported(`malformed checked-dynamic class field '${expr.className}.${expr.field}'`, expr.loc);
          }
          const dynamic = this.context.dynTypeName();
          return `{ let ${object} = ${this.emitExpr(expr.obj)}; ${object}.with_mut(|object| { let ${old} = sc_dyn_check_number(object.${name}.as_ref().expect("scriptc: cleared live dynamic class field").clone()); let ${next} = ${old} ${operation} 1.0; object.${name} = Some(${dynamic}::Number(${next})); ${result} }) }`;
        }
        if (field.type.kind !== "f64") {
          this.context.unsupported(`increment/decrement of class field '${expr.className}.${expr.field}'`, expr.loc);
        }
        return `{ let ${object} = ${this.emitExpr(expr.obj)}; ${object}.with_mut(|object| { let ${old} = object.${name}; let ${next} = ${old} ${operation} 1.0; object.${name} = ${next}; ${result} }) }`;
      }
      case "jsMarshal":
      case "jsExit":
      case "jsOp":
      case "jsBridgePromise":
        return emitRustIslandExpr(expr, this.context, (value) => this.emitExpr(value));
      default:
        this.context.unsupported(`expression '${expr.kind}'`, expr.loc);
    }
  }
}
