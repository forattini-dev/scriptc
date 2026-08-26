import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../ir/nodes.js";
import { typeKey } from "../../ir/nodes.js";
import { mangleField, mangleLocal, mangleRecordStruct } from "../mangle.js";

export interface RustGeneratorBodyContext {
  line(value: string): void;
  pushIndent(): void;
  popIndent(): void;
  nextName(prefix: string): string;
  assignmentExpr(id: string, value: string, loc: SrcLoc): string;
  emitExpr(expr: IrExpr): string;
  emitExprWithValues(expr: IrExpr, values: readonly (readonly [IrExpr, string])[]): string;
  emitStatements(statements: readonly IrStmt[]): void;
  rustType(type: IrType, loc?: SrcLoc): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

function containsYield(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsYield);
  const node = value as { kind?: unknown };
  if (node.kind === "yieldExpr") return true;
  return Object.values(value).some(containsYield);
}

function channelType(type: IrType, context: RustGeneratorBodyContext, loc: SrcLoc): string {
  return type.kind === "undefinedT" || type.kind === "nullT" ? "()" : context.rustType(type, loc);
}

function generatorStepType(fn: IrFunction, context: RustGeneratorBodyContext): string {
  if (fn.generator === undefined) context.unsupported(`non-generator function '${fn.name}'`, fn.loc);
  return `runtime::GeneratorStep<${channelType(fn.generator.yieldT, context, fn.loc)}, ${channelType(fn.returnType, context, fn.loc)}>`;
}

function emitGeneratorValue(
  fn: IrFunction,
  expr: IrExpr,
  context: RustGeneratorBodyContext,
  consume: (value: string) => void,
): void {
  if (expr.kind === "yieldExpr") {
    const yielded = expr.value;
    if (yielded === null || fn.generator === undefined) {
      context.unsupported("generator yield without a typed value", expr.loc);
    }
    emitGeneratorValue(fn, yielded, context, (yieldedValue) => {
      const next = context.nextName("sc_generator_next");
      context.line(`let sc_yielded = ${yieldedValue};`);
      context.line("runtime::generator_suspend(&sc_generator, move |sc_generator, sc_command| {");
      context.pushIndent();
      context.line("match sc_command {");
      context.pushIndent();
      context.line(`runtime::GeneratorCommand::Next(${next}) => {`);
      context.pushIndent();
      consume(expr.type.kind === "void" ? "()" : `${next}.clone()`);
      context.popIndent();
      context.line("},");
      context.line("runtime::GeneratorCommand::Return(value) => runtime::GeneratorStep::Returned(value),");
      context.line("runtime::GeneratorCommand::Throw(reason) => runtime::rethrow_caught(reason),");
      context.popIndent();
      context.line("}");
      context.popIndent();
      context.line("});");
      context.line("return runtime::GeneratorStep::Yielded(sc_yielded);");
    });
    return;
  }
  if (expr.kind === "bin") {
    emitGeneratorValue(fn, expr.left, context, (left) => {
      emitGeneratorValue(fn, expr.right, context, (right) => {
        consume(context.emitExprWithValues(expr, [[expr.left, left], [expr.right, right]]));
      });
    });
    return;
  }
  if (expr.kind === "dynCheck" && containsYield(expr.value)) {
    emitGeneratorValue(fn, expr.value, context, (value) => {
      consume(context.emitExprWithValues(expr, [[expr.value, value]]));
    });
    return;
  }
  if (containsYield(expr)) context.unsupported("nested generator value in the Rust state-machine subset", expr.loc);
  consume(context.emitExpr(expr));
}

function emitGeneratorWhile(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "while" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: ReadonlySet<string>,
  onComplete: (() => void) | null,
): void {
  if ((statement.labels?.length ?? 0) > 0 || containsYield(statement.cond)) {
    context.unsupported("labeled generator while or yield in its condition", statement.loc);
  }
  const helper = context.nextName("sc_generator_while");
  const active = [...locals].map((id) => {
    const local = fn.locals.find((candidate) => candidate.id === id);
    if (local === undefined) context.unsupported(`unknown generator local '${id}'`, statement.loc);
    return local;
  });
  const generatorType: IrType = {
    kind: "generator",
    yieldT: fn.generator?.yieldT ?? context.unsupported("generator while outside generator", statement.loc),
    retT: fn.returnType,
    nextT: fn.generator?.nextT ?? context.unsupported("generator while outside generator", statement.loc),
  };
  const params = [
    `sc_generator: ${context.rustType(generatorType, statement.loc)}`,
    ...active.map((local) =>
      `${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, statement.loc)}>`
    ),
  ];
  const call = `${helper}(${[
    "sc_generator",
    ...active.map((local) => `${mangleLocal(local.id)}.clone()`),
  ].join(", ")})`;
  context.line(`fn ${helper}(${params.join(", ")}) -> ${generatorStepType(fn, context)} {`);
  context.pushIndent();
  context.line(`if ${context.emitExpr(statement.cond)} {`);
  context.pushIndent();
  emitGeneratorSequence(fn, statement.body, context, new Set(locals), () => {
    context.line(`return ${call};`);
  });
  context.popIndent();
  context.line("} else {");
  context.pushIndent();
  emitGeneratorSequence(fn, remaining, context, new Set(locals), onComplete);
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`return ${call};`);
}

function emitGeneratorIf(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "if" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: ReadonlySet<string>,
  onComplete: (() => void) | null,
): void {
  if (containsYield(statement.cond)) context.unsupported("yield in generator if condition", statement.loc);
  context.line(`if ${context.emitExpr(statement.cond)} {`);
  context.pushIndent();
  emitGeneratorSequence(fn, [...statement.then, ...remaining], context, new Set(locals), onComplete);
  context.popIndent();
  context.line("} else {");
  context.pushIndent();
  emitGeneratorSequence(fn, [...(statement.else_ ?? []), ...remaining], context, new Set(locals), onComplete);
  context.popIndent();
  context.line("}");
}

function emitGeneratorSequence(
  fn: IrFunction,
  statements: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: Set<string>,
  onComplete: (() => void) | null = null,
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) break;
    if (statement.kind === "return") {
      const value = statement.value === null ? "None" : `Some(${context.emitExpr(statement.value)})`;
      context.line(`return runtime::GeneratorStep::Returned(${value});`);
      return;
    }
    if (statement.kind === "while" && containsYield(statement.body)) {
      emitGeneratorWhile(fn, statement, statements.slice(index + 1), context, locals, onComplete);
      return;
    }
    if (statement.kind === "if") {
      emitGeneratorIf(fn, statement, statements.slice(index + 1), context, locals, onComplete);
      return;
    }
    const nested = statement.kind === "assign" ? statement.value
      : statement.kind === "varDecl" ? statement.init
      : statement.kind === "exprStmt" ? statement.expr
      : null;
    if (nested !== null && containsYield(nested)) {
      emitGeneratorValue(fn, nested, context, (value) => {
        if (statement.kind === "assign") {
          context.line(context.assignmentExpr(statement.localId, value, statement.loc));
        } else if (statement.kind === "varDecl") {
          const local = fn.locals.find((candidate) => candidate.id === statement.localId);
          if (local === undefined) context.unsupported(`unknown generator local '${statement.localId}'`, statement.loc);
          context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, statement.loc)}> = runtime::cell_new(${value});`);
          locals.add(local.id);
        } else {
          context.line(`let _ = ${value};`);
        }
        emitGeneratorSequence(fn, statements.slice(index + 1), context, locals, onComplete);
      });
      return;
    }
    if (containsYield(statement)) context.unsupported("nested generator suspension in the Rust state-machine subset", statement.loc);
    context.emitStatements([statement]);
    if (statement.kind === "varDecl") locals.add(statement.localId);
  }
  if (onComplete !== null) {
    onComplete();
  } else if (fn.returnType.kind === "void") {
    context.line("runtime::GeneratorStep::Returned(None)");
  } else {
    context.line(`unreachable!("scriptc invariant: generator '${fn.name}' fell through")`);
  }
}

export function emitRustGeneratorBody(fn: IrFunction, context: RustGeneratorBodyContext): void {
  if (fn.generator === undefined) context.unsupported(`non-generator function '${fn.name}'`, fn.loc);
  const channels = [fn.generator.yieldT, fn.returnType, fn.generator.nextT]
    .map((type) => channelType(type, context, fn.loc)).join(", ");
  context.line(`runtime::generator_new::<${channels}, _>(move |sc_generator, sc_command| {`);
  context.pushIndent();
  context.line("let _ = sc_command;");
  emitGeneratorSequence(fn, fn.body, context, new Set([
    ...fn.params.map((param) => param.localId),
    ...(fn.captures ?? []).map((capture) => capture.localId),
  ]));
  context.popIndent();
  context.line("})");
}

type GeneratorResumeExpr = Extract<IrExpr, { kind: "genResume" }>;

export interface RustGeneratorResumeContext {
  readonly records: ReadonlyMap<string, IrRecordShape>;
  nextName(prefix: string): string;
  dynTypeName(): string;
  isEdgeValue(type: IrType): boolean;
  union(id: string, loc?: SrcLoc): IrUnionDef;
  unionName(id: string): string;
  unionVariant(tag: number): string;
  unsupported(kind: string, loc?: SrcLoc): never;
}

export function emitRustGeneratorResume(
  expr: GeneratorResumeExpr,
  context: RustGeneratorResumeContext,
  emitExpr: (value: IrExpr) => string,
): string {
  if (expr.gen.type.kind !== "generator" || expr.type.kind !== "record") {
    context.unsupported("generator resume shape", expr.loc);
  }
  if (expr.mode === "throw") context.unsupported("generator throw resume", expr.loc);
  const generatorType = expr.gen.type;
  const shape = context.records.get(expr.type.shapeId);
  const doneField = shape?.fields.find((field) => field.name === "done");
  const valueField = shape?.fields.find((field) => field.name === "value");
  if (shape === undefined || shape.indexValue !== undefined || doneField?.type.kind !== "bool" ||
    valueField?.type.kind !== "union") {
    context.unsupported("generator IteratorResult record", expr.loc);
  }
  const valueUnion = context.union(valueField.type.unionId, expr.loc);
  const undefinedTag = valueUnion.arms.findIndex((arm) => arm.kind === "undefinedT");
  if (undefinedTag < 0) context.unsupported("generator result without undefined arm", expr.loc);
  const wrap = (type: IrType, value: string): string => {
    const tag = valueUnion.arms.findIndex((arm) => typeKey(arm) === typeKey(type));
    if (tag < 0) context.unsupported(`generator result missing '${type.kind}' arm`, expr.loc);
    return `${context.unionName(valueUnion.id)}::${context.unionVariant(tag)}(${value})`;
  };
  const undefinedValue = `${context.unionName(valueUnion.id)}::${context.unionVariant(undefinedTag)}`;
  const record = (done: boolean, value: string): string => {
    const fields = shape.fields.map((field) => {
      const raw = field.name === "done" ? String(done) : field.name === "value" ? value :
        context.unsupported(`unexpected IteratorResult field '${field.name}'`, expr.loc);
      return `${mangleField(field.name)}: ${context.isEdgeValue(field.type) ? `Some(${raw})` : raw}`;
    }).join(", ");
    return `runtime::Gc::new(${mangleRecordStruct(shape.id)} { ${fields} })`;
  };
  const yielded = generatorType.yieldT.kind === "void"
    ? "runtime::GeneratorStep::Yielded(_) => unreachable!(\"scriptc invariant: void generator yielded\")"
    : `runtime::GeneratorStep::Yielded(value) => ${record(false, wrap(generatorType.yieldT, "value"))}`;
  const returned = generatorType.retT.kind === "void"
    ? `runtime::GeneratorStep::Returned(Some(_)) => ${record(true, undefinedValue)}`
    : `runtime::GeneratorStep::Returned(Some(value)) => ${record(true, wrap(generatorType.retT, "value"))}`;
  const generator = context.nextName("sc_generator");
  const argument = context.nextName("sc_generator_arg");
  let argumentExpr: string;
  if (expr.arg !== null) argumentExpr = emitExpr(expr.arg);
  else if (expr.mode === "return") argumentExpr = "None";
  else if (generatorType.nextT.kind === "dyn") argumentExpr = `${context.dynTypeName()}::Undefined`;
  else if (generatorType.nextT.kind === "undefinedT" || generatorType.nextT.kind === "void") argumentExpr = "()";
  else context.unsupported("valueless generator next", expr.loc);
  const call = expr.mode === "next"
    ? `runtime::generator_next(&${generator}, ${argument})`
    : `runtime::generator_return(&${generator}, ${expr.arg === null ? argument : `Some(${argument})`})`;
  return `{ let ${generator} = ${emitExpr(expr.gen)}; let ${argument} = ${argumentExpr}; match ${call} { ${yielded}, ${returned}, runtime::GeneratorStep::Returned(None) => ${record(true, undefinedValue)}, } }`;
}
