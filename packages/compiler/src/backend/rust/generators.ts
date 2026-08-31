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

interface GeneratorFlow {
  readonly captures: readonly { parameter: string; argument: string }[];
  emitReturn(value: string): void;
  emitThrow(reason: string): void;
  emitBreak(): void;
  emitContinue(): void;
}

function emitGeneratorValue(
  fn: IrFunction,
  expr: IrExpr,
  context: RustGeneratorBodyContext,
  flow: GeneratorFlow,
  consume: (value: string) => void,
): void {
  if (expr.kind === "yieldExpr") {
    const yielded = expr.value;
    if (yielded === null || fn.generator === undefined) {
      context.unsupported("generator yield without a typed value", expr.loc);
    }
    emitGeneratorValue(fn, yielded, context, flow, (yieldedValue) => {
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
      context.line("runtime::GeneratorCommand::Return(value) => {");
      context.pushIndent();
      flow.emitReturn("value");
      context.popIndent();
      context.line("},");
      context.line("runtime::GeneratorCommand::Throw(reason) => {");
      context.pushIndent();
      flow.emitThrow("reason");
      context.popIndent();
      context.line("},");
      context.popIndent();
      context.line("}");
      context.popIndent();
      context.line("});");
      context.line("return runtime::GeneratorStep::Yielded(sc_yielded);");
    });
    return;
  }
  if (expr.kind === "bin") {
    emitGeneratorValue(fn, expr.left, context, flow, (left) => {
      emitGeneratorValue(fn, expr.right, context, flow, (right) => {
        consume(context.emitExprWithValues(expr, [[expr.left, left], [expr.right, right]]));
      });
    });
    return;
  }
  if (expr.kind === "logical") {
    emitGeneratorValue(fn, expr.left, context, flow, (leftValue) => {
      const left = context.nextName("sc_generator_logical");
      context.line(`let ${left} = ${leftValue};`);
      const truthy: IrExpr = {
        kind: "toBool",
        operand: expr.left,
        type: { kind: "bool" },
        loc: expr.loc,
      };
      const condition = context.emitExprWithValues(truthy, [[expr.left, `${left}.clone()`]]);
      const takeRight = expr.op === "&&" ? condition : `!(${condition})`;
      context.line(`if ${takeRight} {`);
      context.pushIndent();
      emitGeneratorValue(fn, expr.right, context, flow, consume);
      context.popIndent();
      context.line("} else {");
      context.pushIndent();
      consume(`${left}.clone()`);
      context.popIndent();
      context.line("}");
    });
    return;
  }
  if (expr.kind === "dynCheck" && containsYield(expr.value)) {
    emitGeneratorValue(fn, expr.value, context, flow, (value) => {
      consume(context.emitExprWithValues(expr, [[expr.value, value]]));
    });
    return;
  }
  if (expr.kind === "genResume" && expr.arg !== null && containsYield(expr.arg)) {
    const argument = expr.arg;
    emitGeneratorValue(fn, argument, context, flow, (value) => {
      consume(context.emitExprWithValues(expr, [[argument, value]]));
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
  flow: GeneratorFlow,
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
    ...flow.captures.map((capture) => capture.parameter),
  ];
  const call = `${helper}(${[
    "sc_generator",
    ...active.map((local) => `${mangleLocal(local.id)}.clone()`),
    ...flow.captures.map((capture) => capture.argument),
  ].join(", ")})`;
  const bodyFlow: GeneratorFlow = {
    ...flow,
    emitBreak: () => emitGeneratorSequence(fn, remaining, context,
      new Set(locals), flow, onComplete),
    emitContinue: () => context.line(`return ${call};`),
  };
  context.line(`fn ${helper}(${params.join(", ")}) -> ${generatorStepType(fn, context)} {`);
  context.pushIndent();
  context.line(`if ${context.emitExpr(statement.cond)} {`);
  context.pushIndent();
  emitGeneratorSequence(fn, statement.body, context, new Set(locals), bodyFlow, () => {
    context.line(`return ${call};`);
  });
  context.popIndent();
  context.line("} else {");
  context.pushIndent();
  emitGeneratorSequence(fn, remaining, context, new Set(locals), flow, onComplete);
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
  flow: GeneratorFlow,
  onComplete: (() => void) | null,
): void {
  if (containsYield(statement.cond)) context.unsupported("yield in generator if condition", statement.loc);
  context.line(`if ${context.emitExpr(statement.cond)} {`);
  context.pushIndent();
  emitGeneratorSequence(fn, [...statement.then, ...remaining], context, new Set(locals), flow, onComplete);
  context.popIndent();
  context.line("} else {");
  context.pushIndent();
  emitGeneratorSequence(fn, [...(statement.else_ ?? []), ...remaining], context, new Set(locals), flow, onComplete);
  context.popIndent();
  context.line("}");
}

function emitGeneratorFor(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "for" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: Set<string>,
  flow: GeneratorFlow,
  onComplete: (() => void) | null,
): void {
  if ((statement.labels?.length ?? 0) > 0 || containsYield(statement.init) ||
    containsYield(statement.cond) || containsYield(statement.update)) {
    context.unsupported("labeled generator for or suspension outside its body", statement.loc);
  }
  if (statement.init !== null) {
    context.emitStatements([statement.init]);
    if (statement.init.kind === "varDecl") locals.add(statement.init.localId);
  }
  const condition: IrExpr = statement.cond ?? {
    kind: "boolLit", value: true, type: { kind: "bool" }, loc: statement.loc,
  };
  emitGeneratorWhile(fn, {
    kind: "while",
    cond: condition,
    body: statement.update === null ? statement.body : [...statement.body, statement.update],
    loc: statement.loc,
  }, remaining, context, locals, flow, onComplete);
}

function emitGeneratorForOf(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "forOf" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: ReadonlySet<string>,
  flow: GeneratorFlow,
  onComplete: (() => void) | null,
): void {
  if ((statement.labels?.length ?? 0) > 0 || containsYield(statement.iterable)) {
    context.unsupported("labeled generator for-of or suspension in its iterable", statement.loc);
  }
  if (statement.iterable.type.kind !== "array") {
    context.unsupported("suspended generator for-of over a non-array", statement.loc);
  }
  const local = fn.locals.find((candidate) => candidate.id === statement.localId);
  if (local === undefined) context.unsupported(`unknown generator local '${statement.localId}'`, statement.loc);
  const active = [...locals].map((id) => {
    const candidate = fn.locals.find((entry) => entry.id === id);
    if (candidate === undefined) context.unsupported(`unknown generator local '${id}'`, statement.loc);
    return candidate;
  });
  const helper = context.nextName("sc_generator_for_of");
  const array = context.nextName("sc_generator_array");
  const index = context.nextName("sc_generator_index");
  const generatorType: IrType = {
    kind: "generator",
    yieldT: fn.generator?.yieldT ?? context.unsupported("generator for-of outside generator", statement.loc),
    retT: fn.returnType,
    nextT: fn.generator?.nextT ?? context.unsupported("generator for-of outside generator", statement.loc),
  };
  const params = [
    `sc_generator: ${context.rustType(generatorType, statement.loc)}`,
    `${array}: ${context.rustType(statement.iterable.type, statement.loc)}`,
    `${index}: f64`,
    ...active.map((candidate) =>
      `${mangleLocal(candidate.id)}: runtime::JsCell<${context.rustType(candidate.type, statement.loc)}>`
    ),
    ...flow.captures.map((capture) => capture.parameter),
  ];
  const call = (nextIndex: string): string => `${helper}(${[
    "sc_generator",
    `${array}.clone()`,
    nextIndex,
    ...active.map((candidate) => `${mangleLocal(candidate.id)}.clone()`),
    ...flow.captures.map((capture) => capture.argument),
  ].join(", ")})`;
  const bodyFlow: GeneratorFlow = {
    ...flow,
    captures: [
      ...flow.captures,
      { parameter: `${array}: ${context.rustType(statement.iterable.type, statement.loc)}`, argument: `${array}.clone()` },
      { parameter: `${index}: f64`, argument: index },
    ],
    emitBreak: () => emitGeneratorSequence(fn, remaining, context, new Set(locals), flow, onComplete),
    emitContinue: () => context.line(`return ${call(`${index} + 1.0`)};`),
  };
  context.line(`fn ${helper}(${params.join(", ")}) -> ${generatorStepType(fn, context)} {`);
  context.pushIndent();
  context.line(`if ${index} < runtime::array_len(&${array}) {`);
  context.pushIndent();
  context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<${context.rustType(local.type, statement.loc)}> = runtime::cell_new(runtime::array_get(&${array}, ${index}));`);
  emitGeneratorSequence(fn, statement.body, context, new Set([...locals, local.id]), bodyFlow, () => {
    context.line(`return ${call(`${index} + 1.0`)};`);
  });
  context.popIndent();
  context.line("} else {");
  context.pushIndent();
  emitGeneratorSequence(fn, remaining, context, new Set(locals), flow, onComplete);
  context.popIndent();
  context.line("}");
  context.popIndent();
  context.line("}");
  context.line(`let ${array} = ${context.emitExpr(statement.iterable)};`);
  context.line(`return ${call("0.0")};`);
}

function generatorSwitchBranch(
  statement: Extract<IrStmt, { kind: "switch" }>,
  start: number,
  context: RustGeneratorBodyContext,
): IrStmt[] {
  const result: IrStmt[] = [];
  for (let index = start; index < statement.cases.length; index += 1) {
    const candidate = statement.cases[index];
    if (candidate === undefined) break;
    for (const bodyStatement of candidate.body) {
      if (bodyStatement.kind === "break") {
        if (bodyStatement.label !== undefined) {
          context.unsupported("labeled break in generator switch", bodyStatement.loc);
        }
        return result;
      }
      result.push(bodyStatement);
    }
  }
  return result;
}

function emitGeneratorSwitch(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "switch" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: ReadonlySet<string>,
  flow: GeneratorFlow,
  onComplete: (() => void) | null,
): void {
  if ((statement.labels?.length ?? 0) > 0 || containsYield(statement.disc)) {
    context.unsupported("labeled generator switch or yield in its discriminant", statement.loc);
  }
  const kind = statement.disc.type.kind;
  if (kind !== "f64" && kind !== "string" && kind !== "bool") {
    context.unsupported(`generator switch discriminant '${kind}'`, statement.loc);
  }
  const disc = context.nextName("sc_generator_switch");
  context.line(`let ${disc} = ${context.emitExpr(statement.disc)};`);
  const tested = statement.cases.flatMap((candidate, index) =>
    candidate.test === null ? [] : [{ candidate, index }]
  );
  for (const [{ candidate, index }, branch] of tested.map((entry, index) => [entry, index] as const)) {
    if (candidate.test === null || candidate.test.type.kind !== kind) {
      context.unsupported("generator switch case type mismatch", statement.loc);
    }
    const test = context.nextName("sc_generator_case");
    const equality = kind === "string"
      ? `${disc}.as_ref() == ${test}.as_ref()`
      : `${disc} == ${test}`;
    context.line(`${branch === 0 ? "if" : "else if"} { let ${test} = ${context.emitExpr(candidate.test)}; ${equality} } {`);
    context.pushIndent();
    emitGeneratorSequence(fn, [...generatorSwitchBranch(statement, index, context), ...remaining],
      context, new Set(locals), flow, onComplete);
    context.popIndent();
    context.line("}");
  }
  const defaultIndex = statement.cases.findIndex((candidate) => candidate.test === null);
  if (tested.length > 0) context.line("else {");
  context.pushIndent();
  const fallback = defaultIndex < 0 ? remaining :
    [...generatorSwitchBranch(statement, defaultIndex, context), ...remaining];
  emitGeneratorSequence(fn, fallback, context, new Set(locals), flow, onComplete);
  context.popIndent();
  if (tested.length > 0) context.line("}");
}

function emitGeneratorTry(
  fn: IrFunction,
  statement: Extract<IrStmt, { kind: "tryCatch" }>,
  remaining: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: ReadonlySet<string>,
  outerFlow: GeneratorFlow,
  onComplete: (() => void) | null,
): void {
  const active = [...locals].map((id) => {
    const local = fn.locals.find((candidate) => candidate.id === id);
    if (local === undefined) context.unsupported(`unknown generator local '${id}'`, statement.loc);
    return local;
  });
  const emitFinally = (complete: () => void): void => {
    if (statement.finallyBody === null) complete();
    else emitGeneratorSequence(fn, statement.finallyBody, context,
      new Set(locals), outerFlow, complete);
  };
  const pushHandler = (emitHandler: (reason: string) => void): void => {
    const reason = context.nextName("sc_generator_reason");
    context.line("runtime::generator_push_panic_handler(&sc_generator, {");
    context.pushIndent();
    for (const local of active) {
      const name = mangleLocal(local.id);
      context.line(`let ${name} = ${name}.clone();`);
    }
    context.line(`move |sc_generator, ${reason}| {`);
    context.pushIndent();
    emitHandler(reason);
    context.popIndent();
    context.line("}");
    context.popIndent();
    context.line("});");
  };
  const emitRemaining = (): void =>
    emitGeneratorSequence(fn, remaining, context, new Set(locals), outerFlow, onComplete);
  const emitCatch = (reason: string): void => {
    if (statement.catchBody === null) {
      emitFinally(() => outerFlow.emitThrow(reason));
      return;
    }
    const catchLocals = new Set(locals);
    if (statement.catchLocalId !== null) {
      const local = fn.locals.find((candidate) => candidate.id === statement.catchLocalId);
      if (local === undefined) context.unsupported("missing generator catch local", statement.loc);
      context.line(`let ${mangleLocal(local.id)}: runtime::JsCell<runtime::Caught> = runtime::cell_new(${reason});`);
      catchLocals.add(local.id);
    } else {
      context.line(`let _ = ${reason};`);
    }
    const hasFinally = statement.finallyBody !== null;
    if (hasFinally) pushHandler((caught) => emitFinally(() => outerFlow.emitThrow(caught)));
    const leaveCatch = (complete: () => void): void => {
      if (hasFinally) context.line("runtime::generator_pop_panic_handler(&sc_generator);");
      emitFinally(complete);
    };
    const catchFlow: GeneratorFlow = {
      ...outerFlow,
      emitReturn: (value) => leaveCatch(() => outerFlow.emitReturn(value)),
      emitThrow: (caught) => leaveCatch(() => outerFlow.emitThrow(caught)),
    };
    emitGeneratorSequence(fn, statement.catchBody, context, catchLocals, catchFlow,
      () => leaveCatch(emitRemaining));
  };
  pushHandler(emitCatch);
  const leaveTry = (complete: () => void): void => {
    context.line("runtime::generator_pop_panic_handler(&sc_generator);");
    complete();
  };
  const tryFlow: GeneratorFlow = {
    ...outerFlow,
    emitReturn: (value) => leaveTry(() => emitFinally(() => outerFlow.emitReturn(value))),
    emitThrow: (reason) => leaveTry(() => emitCatch(reason)),
  };
  emitGeneratorSequence(fn, statement.tryBody, context, new Set(locals), tryFlow, () => {
    leaveTry(() => emitFinally(emitRemaining));
  });
}

function emitGeneratorSequence(
  fn: IrFunction,
  statements: readonly IrStmt[],
  context: RustGeneratorBodyContext,
  locals: Set<string>,
  flow: GeneratorFlow,
  onComplete: (() => void) | null = null,
): void {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) break;
    if (statement.kind === "return") {
      const value = statement.value === null ? "None" : `Some(${context.emitExpr(statement.value)})`;
      flow.emitReturn(value);
      return;
    }
    if (statement.kind === "break" || statement.kind === "continue") {
      if (statement.label !== undefined) {
        context.unsupported(`labeled generator ${statement.kind}`, statement.loc);
      }
      if (statement.kind === "break") flow.emitBreak();
      else flow.emitContinue();
      return;
    }
    if (statement.kind === "tryCatch") {
      emitGeneratorTry(fn, statement, statements.slice(index + 1),
        context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "while" && containsYield(statement.body)) {
      emitGeneratorWhile(fn, statement, statements.slice(index + 1), context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "for" && containsYield(statement.body)) {
      emitGeneratorFor(fn, statement, statements.slice(index + 1), context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "forOf" && containsYield(statement.body)) {
      emitGeneratorForOf(fn, statement, statements.slice(index + 1), context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "switch" && containsYield(statement.cases)) {
      emitGeneratorSwitch(fn, statement, statements.slice(index + 1), context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "block" && containsYield(statement.body)) {
      if ((statement.labels?.length ?? 0) > 0) {
        context.unsupported("labeled generator block", statement.loc);
      }
      emitGeneratorSequence(fn, [...statement.body, ...statements.slice(index + 1)],
        context, locals, flow, onComplete);
      return;
    }
    if (statement.kind === "if") {
      emitGeneratorIf(fn, statement, statements.slice(index + 1), context, locals, flow, onComplete);
      return;
    }
    const nested = statement.kind === "assign" ? statement.value
      : statement.kind === "varDecl" ? statement.init
      : statement.kind === "exprStmt" ? statement.expr
      : null;
    if (nested !== null && containsYield(nested)) {
      emitGeneratorValue(fn, nested, context, flow, (value) => {
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
        emitGeneratorSequence(fn, statements.slice(index + 1), context, locals, flow, onComplete);
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
  const flow: GeneratorFlow = {
    captures: [],
    emitReturn: (value) => context.line(`return runtime::GeneratorStep::Returned(${value});`),
    emitThrow: (reason) => context.line(`runtime::rethrow_caught(${reason})`),
    emitBreak: () => context.unsupported("generator break outside a loop", fn.loc),
    emitContinue: () => context.unsupported("generator continue outside a loop", fn.loc),
  };
  emitGeneratorSequence(fn, fn.body, context, new Set([
    ...fn.params.map((param) => param.localId),
    ...(fn.captures ?? []).map((capture) => capture.localId),
  ]), flow);
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
    if (tag >= 0) return `${context.unionName(valueUnion.id)}::${context.unionVariant(tag)}(${value})`;
    if (type.kind !== "union") {
      context.unsupported(`generator result missing '${type.kind}' arm`, expr.loc);
    }
    const source = context.union(type.unionId, expr.loc);
    const arms = source.arms.map((arm, sourceTag) => {
      const targetTag = valueUnion.arms.findIndex((candidate) => typeKey(candidate) === typeKey(arm));
      if (targetTag < 0) context.unsupported(`generator result missing '${arm.kind}' arm`, expr.loc);
      const sourceVariant = `${context.unionName(source.id)}::${context.unionVariant(sourceTag)}`;
      const targetVariant = `${context.unionName(valueUnion.id)}::${context.unionVariant(targetTag)}`;
      return arm.kind === "undefinedT" || arm.kind === "nullT" || arm.kind === "void"
        ? `${sourceVariant} => ${targetVariant}`
        : `${sourceVariant}(payload) => ${targetVariant}(payload)`;
    }).join(", ");
    return `match ${value} { ${arms} }`;
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
  else if (expr.mode === "throw") context.unsupported("valueless generator throw", expr.loc);
  else if (expr.mode === "return") argumentExpr = "None";
  else if (generatorType.nextT.kind === "dyn") argumentExpr = `${context.dynTypeName()}::Undefined`;
  else if (generatorType.nextT.kind === "undefinedT" || generatorType.nextT.kind === "void") argumentExpr = "()";
  else context.unsupported("valueless generator next", expr.loc);
  const call = expr.mode === "next"
    ? `runtime::generator_next(&${generator}, ${argument})`
    : expr.mode === "return"
      ? `runtime::generator_return(&${generator}, ${expr.arg === null ? argument : `Some(${argument})`})`
      : `runtime::generator_throw(&${generator}, runtime::caught_value(${argument}))`;
  return `{ let ${generator} = ${emitExpr(expr.gen)}; let ${argument} = ${argumentExpr}; match ${call} { ${yielded}, ${returned}, runtime::GeneratorStep::Returned(None) => ${record(true, undefinedValue)}, } }`;
}
