/* Function-value adapters: a closure whose signature differs from its slot — return width lifts, parameter and return
 * coercions, dynamic-rest island adapters, and child_process spawn result adapters. */
import { InternalCompilerError } from "../../errors.js";
import type {
  IrClassDef,
  IrExpr,
  IrFfiImport,
  IrFunction,
  IrGlobal,
  IrLocal,
  IrModule,
  IrParam,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import { canBoxFuncIntoDyn, canConvertToDyn, canDynCheckTo, canMarshalTypedFuncIntoIsland, DYN, F64, JSVAL, STRING, typeEquals, UNDEFINED_T } from "../../ir/ir.js";
import {
  typeKey,
} from "../type-mapper.js";
import type { ExpandoMember } from "./lower-expando.js";
import type { Lowerer } from "./lowerer.js";
import { dynUndefinedExpr } from "./lowerer.js";

  /** Interned `%fn.width.<n>(f)` — the function-RETURN width adapter: a
   * zero-param `() => Wide[]` value flowing into a `() => Narrow[]` slot
   * (the createProxyServer getRoutes shape) wraps in a fresh closure that
   * calls the original and maps the result through the per-element record
   * width copy (%arr.width). The adapter is a factory lifted function
   * whose param the returned closure captures; each invocation of the
   * adapted value builds a FRESH array of narrowed records (the width
   * machinery's copy stance — callers see the values, not the identity).
   * Null when the return shapes aren't width-coercible; bounded to
   * zero-param signatures (the one observed site — widening needs a
   * param-forwarding story nothing drives yet). */
  export function funcReturnWidthAdapter(lowerer: Lowerer, fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    if (fromT.params.length !== 0 || toT.params.length !== 0) return null;
    if (fromT.ret.kind !== "array" || toT.ret.kind !== "array") return null;
    const mapper = lowerer.arrayWidthHelper(fromT.ret, toT.ret, loc);
    if (!mapper) return null;
    const key = `fn:${typeKey(fromT.ret.elem)}:${typeKey(toT.ret.elem)}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%fn.width.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    lowerer.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    // The returned closure's body: call the captured original, width-map.
    lowerer.liftedFns.push({
      name: impl,
      params: [],
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: {
            kind: "call",
            callee: mapper,
            args: [
              {
                kind: "callValue",
                callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
                args: [],
                type: fromT.ret,
                loc,
              },
            ],
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    // The factory: box the incoming function value, mint the closure.
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Interned `%fn.adapt.<n>(f)` — the GENERAL function-value adapter: a
   * `fromT` function value flowing into a `toT` slot whose pieces differ
   * only by coercibleValue conversions. The slot's callers pass toT's
   * parameters: the wrapper takes them, converts the first
   * fromT.params.length into the wrapped function's own types (surplus
   * slot parameters are DROPPED — JS's extra-argument rule), calls it,
   * and converts the result back (a void slot drops the result; a void
   * result wraps as the slot union's undefined arm). Rest signatures on
   * either side decline (the pack shapes don't line up mechanically).
   * Null when any piece is outside coercibleValue — the exactness fences
   * stay. */
  export function funcCoerceAdapter(lowerer: Lowerer, fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    if (fromT.rest === true || toT.rest === true) return null;
    if (fromT.params.length > toT.params.length) return null;
    // Piece dispositions beyond coercibleValue, all CHECKER-APPROVED
    // function compatibilities (bivariant method params under the suite's
    // non-strict settings, `() => never` throwers displayed as void by
    // the type mapping, void functions into unknown/any-returning slots):
    // - strandParams: some parameter cannot convert — the assignment
    //   compiles, INVOKING the slot throws the stranded TypeError (a
    //   never-called mismatched callback is exact; divergence 38's stance
    //   extended to calls).
    // - voidRet "dyn"/"jsval": calling yields JS's undefined — the exact
    //   undefined dyn/engine value after the call's effects.
    // - voidRet "strand": a void result where the slot promises a typed
    //   value — the call runs (a `never` thrower never comes back, so the
    //   trap is unreachable there), then the stranded TypeError.
    let strandParams = false;
    for (let i = 0; i < fromT.params.length; i++) {
      if (!lowerer.coercibleValue(toT.params[i]!, fromT.params[i]!)) strandParams = true;
    }
    let voidRet: "dyn" | "jsval" | "strand" | null = null;
    let strandRet = false;
    if (toT.ret.kind !== "void" && !lowerer.coercibleValue(fromT.ret, toT.ret)) {
      if (fromT.ret.kind !== "void") {
        // A RESULT that cannot convert — the strandParams stance, result
        // side (the production/development function-choice ternary: the
        // untaken arm's result shape never lands in the slot's): the
        // assignment compiles, INVOKING the slot runs the function and
        // throws the stranded TypeError where its result would convert.
        strandRet = true;
      } else {
        voidRet = toT.ret.kind === "dyn" ? "dyn" : toT.ret.kind === "jsval" ? "jsval" : "strand";
      }
    }
    if (toT.ret.kind === "void" && fromT.ret.kind === "jsval") return null;
    const key = `fnadapt:${typeKey(fromT)}:${typeKey(toT)}`;
    const existing = lowerer.retagHelpers.get(key);
    if (existing) return existing;
    const name = `%fn.adapt.${lowerer.retagHelpers.size}`;
    lowerer.retagHelpers.set(key, name);
    lowerer.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    const params: IrParam[] = toT.params.map((t, i) => ({ localId: `a.${i}`, name: `a${i}`, type: t }));
    const strandThrow = (why: string): IrStmt => ({
      kind: "throw",
      value: {
        kind: "libCall",
        fn: "error.new",
        args: [{ kind: "strLit", value: why, type: STRING, loc }],
        type: { kind: "object", className: "%TypeError" },
        loc,
      },
      loc,
    });
    let body: IrStmt[];
    if (strandParams) {
      body = [
        strandThrow(
          `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the parameter types cannot convert — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
        ),
      ];
    } else {
      const args = fromT.params.map((pt, i) => {
        const aRef: IrExpr = { kind: "varRef", localId: `a.${i}`, type: toT.params[i]!, loc };
        const converted = lowerer.coerceToExpected(aRef, pt);
        if (!typeEquals(converted.type, pt)) throw new InternalCompilerError("lowerer bug: probed fn-adapter param stopped coercing");
        return converted;
      });
      const call: IrExpr = {
        kind: "callValue",
        callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
        args,
        type: fromT.ret,
        loc,
      };
      if (toT.ret.kind === "void") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: null, loc },
        ];
      } else if (voidRet === "dyn") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: dynUndefinedExpr(loc), loc },
        ];
      } else if (voidRet === "jsval") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: { kind: "jsOp", op: "undefLit", args: [], type: JSVAL, loc }, loc },
        ];
      } else if (voidRet === "strand") {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a void result where the '${lowerer.fmt(toT)}' slot promises '${lowerer.fmt(toT.ret)}' (a thrower typed 'never' never reaches this; a genuinely void function has no result to hand over)`,
          ),
        ];
      } else if (strandRet) {
        body = [
          { kind: "exprStmt", expr: call, loc },
          strandThrow(
            `a '${lowerer.fmt(fromT)}' function invoked through a '${lowerer.fmt(toT)}' slot (the result cannot convert to '${lowerer.fmt(toT.ret)}' — the checker's loose function compatibility admitted the assignment, but the call has no exact lowering)`,
          ),
        ];
      } else {
        const result = lowerer.coerceToExpected(call, toT.ret);
        if (!typeEquals(result.type, toT.ret)) throw new InternalCompilerError("lowerer bug: probed fn-adapter return stopped coercing");
        body = [{ kind: "return", value: result, loc }];
      }
    }
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [
        { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
        ...toT.params.map((t, i) => ({ id: `a.${i}`, name: `a${i}`, type: t, mutable: false })),
      ],
      body,
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }

  /** Adapt a checked-dynamic variadic closure (`...unknown[]` / `...any[]`)
   * into the island callback ABI. The island-facing closure receives its
   * fixed arguments normally and one trailing engine array containing all
   * surplus arguments. Its body boxes the original closure, converts the
   * fixed arguments to dyn, wraps the engine array as dyn, and invokes the
   * original through the spread-aware dynCall path. The outer builder also
   * copies the original function's dynamic own properties onto the wrapper,
   * preserving component metadata such as displayName. */
  export function dynRestIslandAdapter(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr | null {
    const fromT = value.type;
    if (
      fromT.kind !== "func" || fromT.rest !== true || fromT.restAbi === "jsval" ||
      !canBoxFuncIntoDyn(fromT, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id)) ||
      !fromT.params.every((p) => canConvertToDyn(p, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) ||
      !(
        fromT.ret.kind === "void" || fromT.ret.kind === "dyn" || fromT.ret.kind === "jsval" ||
        canDynCheckTo(fromT.ret, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
      )
    ) {
      return null;
    }
    const toT: IrType & { kind: "func" } = {
      kind: "func",
      params: [...fromT.params, JSVAL],
      ret: fromT.ret,
      rest: true,
      restAbi: "jsval",
    };
    if (!canMarshalTypedFuncIntoIsland(toT, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) {
      return null;
    }
    const key = `fn-island-rest:${typeKey(fromT)}`;
    let name = lowerer.retagHelpers.get(key);
    if (!name) {
      name = `%fn.islandrest.${lowerer.retagHelpers.size}`;
      lowerer.retagHelpers.set(key, name);
      lowerer.freshClosureAdapters.add(name);
      const impl = `${name}.impl`;
      const params: IrParam[] = toT.params.map((t, i) => ({
        localId: `a.${i}`,
        name: i === toT.params.length - 1 ? "rest" : `a${i}`,
        type: t,
      }));
      const fixedArgs = fromT.params.map((t, i): IrExpr => {
        const ref: IrExpr = { kind: "varRef", localId: `a.${i}`, type: t, loc };
        return lowerer.coerceToExpected(ref, DYN);
      });
      const restIndex = toT.params.length - 1;
      const restRef: IrExpr = { kind: "varRef", localId: `a.${restIndex}`, type: JSVAL, loc };
      const boxed: IrExpr = {
        kind: "dynFrom",
        value: { kind: "varRef", localId: "f.0", type: fromT, loc },
        type: DYN,
        loc,
      };
      const call: IrExpr = {
        kind: "dynCall",
        callee: boxed,
        calleeName: "function",
        args: [...fixedArgs, { kind: "dynFromJsval", value: restRef, type: DYN, loc }],
        spreads: [{ arg: restIndex, what: "rest arguments" }],
        type: DYN,
        loc,
      };
      const body: IrStmt[] = fromT.ret.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }, { kind: "return", value: null, loc }]
        : [{
            kind: "return",
            value: fromT.ret.kind === "dyn" ? call : lowerer.coerceToExpected(call, fromT.ret),
            loc,
          }];
      lowerer.liftedFns.push({
        name: impl,
        params,
        returnType: fromT.ret,
        captures: [{ localId: "f.0", name: "f", type: fromT }],
        locals: [
          { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
          ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        ],
        body,
        loc,
      });
      const wrapped: IrExpr = { kind: "varRef", localId: "wrapped.0", type: toT, loc };
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "f.0", name: "f", type: fromT }],
        returnType: toT,
        locals: [
          { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
          { id: "wrapped.0", name: "wrapped", type: toT, mutable: false },
        ],
        body: [
          {
            kind: "varDecl",
            localId: "wrapped.0",
            init: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "dyn.assign",
              args: [
                { kind: "dynFrom", value: wrapped, type: DYN, loc },
                {
                  kind: "dynFrom",
                  value: { kind: "varRef", localId: "f.0", type: fromT, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            },
            loc,
          },
          { kind: "return", value: wrapped, loc },
        ],
        loc,
      });
    }
    return { kind: "call", callee: name, args: [value], type: toT, loc };
  }

  /** The spawnSync-runner VALUE adapter's plan — a function returning the
   * opaque spawnRes flowing into a slot whose signature returns the
   * STRUCTURAL result record tsc accepted (`defaultRunner` into a
   * `CommandRunner` param: `{ status: number | null; stdout?: string;
   * stderr?: string; error?: Error }`). Parameters must agree pairwise;
   * each target field must be one of the spawnRes reads (status, stdout,
   * stderr, error) at its exact lowered type — string fields optionally
   * undefined-armed. Null when the pair isn't this shape. Pure: callers
   * probe before interning. */
  export function spawnResFnAdapterPlan(lowerer: Lowerer, fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }): { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] | null {
    if (!Array.isArray(fromT.params) || !Array.isArray(toT.params)) return null; // defensive: degenerate func types
    if (fromT.params.length !== toT.params.length) return null;
    if (!fromT.params.every((p, i) => typeEquals(p, toT.params[i]!))) return null;
    if (fromT.ret.kind !== "spawnRes" || toT.ret.kind !== "record") return null;
    const shape = lowerer.shapes.get(toT.ret.shapeId);
    if (!shape || shape.tuple || shape.indexValue) return null;
    const statusT: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, { kind: "nullT" }]) };
    const errorT: IrType = { kind: "union", unionId: lowerer.unions.intern([{ kind: "object", className: "%Error" }, UNDEFINED_T]) };
    const strOptT: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
    const plan: { field: string; build: (r: IrExpr, loc: SrcLoc) => IrExpr }[] = [];
    for (const f of shape.fields) {
      if (f.name === "status" && typeEquals(f.type, statusT)) {
        plan.push({ field: f.name, build: (r, loc) => ({ kind: "libCall", fn: "spawnRes.status", args: [r], type: statusT, loc }) });
        continue;
      }
      if ((f.name === "stdout" || f.name === "stderr") && (typeEquals(f.type, strOptT) || f.type.kind === "string")) {
        const fn = f.name === "stdout" ? ("spawnRes.stdout" as const) : ("spawnRes.stderr" as const);
        const strTag = lowerer.armTag(strOptT.kind === "union" ? strOptT.unionId : "", STRING);
        plan.push({
          field: f.name,
          build: (r, loc) => {
            const read: IrExpr = { kind: "libCall", fn, args: [r], type: STRING, loc };
            return f.type.kind === "string"
              ? read
              : { kind: "unionWrap", unionId: (f.type as IrType & { kind: "union" }).unionId, tag: strTag, value: read, type: f.type, loc };
          },
        });
        continue;
      }
      if (f.name === "error" && typeEquals(f.type, errorT)) {
        plan.push({ field: f.name, build: (r, loc) => ({ kind: "libCall", fn: "spawnRes.error", args: [r], type: errorT, loc }) });
        continue;
      }
      return null;
    }
    return plan;
  }

  /** Interned `%fnval.spawnres.<n>(f)` — the runner-value adapter: a
   * fresh closure of the TARGET signature forwarding its arguments to the
   * captured function and converting the opaque spawnRes result into the
   * target's structural record (one eager read per declared field —
   * spawnResFnAdapterPlan's set). Divergence caveat: stdout/stderr read
   * as the captured text ("" when nothing was captured, e.g. stdio
   * "inherit") where Node stores null. */
  export function spawnResFnAdapter(lowerer: Lowerer, fromT: IrType & { kind: "func" }, toT: IrType & { kind: "func" }, loc: SrcLoc): string | null {
    const plan = lowerer.spawnResFnAdapterPlan(fromT, toT);
    if (!plan) return null;
    if (toT.ret.kind !== "record") return null;
    const key = `fnspawn:${typeKey(fromT)}:${typeKey(toT)}`;
    const existing = lowerer.widthHelpers.get(key);
    if (existing) return existing;
    const name = `%fnval.spawnres.${lowerer.widthHelpers.size}`;
    lowerer.widthHelpers.set(key, name);
    lowerer.freshClosureAdapters.add(name); // wraps `f` in a new closure per call

    const impl = `${name}.impl`;
    const params: IrParam[] = toT.params.map((p, i) => ({ localId: `p${i}.0`, name: `p${i}`, type: p }));
    const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: fromT.ret, loc };
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: toT.ret,
      captures: [{ localId: "f.0", name: "f", type: fromT }],
      locals: [
        { id: "f.0", name: "f", type: fromT, mutable: false, boxed: true },
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
        { id: "r.0", name: "r", type: fromT.ret, mutable: false },
      ],
      body: [
        {
          kind: "varDecl",
          localId: "r.0",
          init: {
            kind: "callValue",
            callee: { kind: "varRef", localId: "f.0", type: fromT, loc },
            args: params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
            type: fromT.ret,
            loc,
          },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "recordLit",
            fields: plan.map((entry) => ({ name: entry.field, value: entry.build(rRef, loc) })),
            type: toT.ret,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "f.0", name: "f", type: fromT }],
      returnType: toT,
      locals: [{ id: "f.0", name: "f", type: fromT, mutable: false, boxed: true }],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["f.0"], type: toT, loc },
          loc,
        },
      ],
      loc,
    });
    return name;
  }
