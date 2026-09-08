import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import { InternalCompilerError } from "../../errors.js";
import { DYN, JSVAL, STRING, type IrExpr } from "../../ir/nodes.js";
import type { Lowerer } from "./lowerer.js";
import { nativeImportHandleType } from "./lower-native-import-types.js";

/** `JSON.parse(text)` / `JSON.stringify(value)`.
   * - parse → a may-throw `libCall` producing a dyn value (the runtime JSON
   *   dyn); malformed input throws a catchable SyntaxError-shaped string.
   *   The divergence override types the one-argument form `unknown`; the
   *   lib's reviver form typechecks (returning `any`) and is fenced here.
   * - stringify → the type-DIRECTED `jsonStringify` node: the lib
   *   signature honestly says `any`, but lowering requires the argument's
   *   STATIC IR type to be JSON-safe — the backend emits a per-type
   *   serializer, never a dynamic walk, so dyn (and closures/class
   *   instances) are rejected here with a specific message. The
   *   `stringify(v, null, space)` pretty-print form compiles when the
   *   replacer is the literal null (or undefined) and the space is a
   *   LITERAL — Node's rules apply at compile time (numbers clamp to 0–10
   *   spaces, strings truncate to 10 code units) and the resolved indent
   *   rides the node to the backend's re-indenter. Function replacers and
   *   non-literal spaces stay fenced.
   * Null when this isn't a JSON member call. */
  export function lowerJsonMethodCall(L: Lowerer, call: ts.CallExpression,
    access: ts.PropertyAccessExpression,): IrExpr | null {
    if (call.questionDotToken) return null;
    const member = L.stdlibGlobalMember(access, "JSON");
    if (member === null) return null;
    const loc = locOf(call);
    if (member === "parse" && call.arguments.length !== 1) {
      L.noLowering(
        "JSON.parse with a reviver",
        call,
        "parse to `unknown` and validate with a checked cast ('as T') instead",
      );
    }
    if (member === "parse") {
      const text = L.lowerExprExpecting(call.arguments[0]!, STRING);
      return { kind: "libCall", fn: "json.parse", args: [text], type: DYN, loc };
    }
    if (member === "stringify") {
      const indent = stringifySpaceIndent(L, call);
      const argNode = call.arguments[0]!;
      const value = nativeImportHandleType(L, argNode)?.kind === "jsval"
        ? L.coerceToExpected(L.lowerExpr(argNode), DYN) : L.lowerExpr(argNode);
      // An ISLAND value (`JSON.stringify(err)` on a package handle — the
      // island error-inspection idiom): the ENGINE's own JSON.stringify
      // runs, so key order, nesting, toJSON, and getters match Node by
      // construction, and the result converts to a static string through
      // the engine's own ToString — a root the stringify DROPS (undefined,
      // a bare function, a symbol) produces the TEXT "undefined" where
      // Node produces the undefined VALUE, exactly the dyn-root rule
      // (SEMANTICS.md 285: tsc's own lib types the return `string`, so no
      // statically-typed consumer can distinguish them). The compile-time-
      // resolved indent rides as the engine's own space argument.
      if (value.type.kind === "jsval") {
        const json: IrExpr = { kind: "jsOp", op: "globalGet", name: "JSON", args: [], type: JSVAL, loc };
        const args: IrExpr[] = [json, value];
        if (indent !== "") {
          args.push(
            { kind: "jsOp", op: "nullLit", args: [], type: JSVAL, loc },
            { kind: "jsMarshal", value: { kind: "strLit", value: indent, type: STRING, loc }, type: JSVAL, loc },
          );
        }
        const raw: IrExpr = { kind: "jsOp", op: "callMethod", name: "stringify", args, type: JSVAL, loc };
        return { kind: "jsOp", op: "toStr", args: [raw], type: STRING, loc };
      }
      // A dyn ROOT (`JSON.stringify(u)` over unknown / `{}` / `Object` /
      // `object` slots, the JSON.parse round-trip) serializes with the
      // runtime's dyn walker instead of a type-directed serializer — the
      // dyn is JSON-representable by construction (non-JSON values fenced
      // at their conversion INTO the slot). Two edges, both documented:
      // a root the stringify drops (runtime undefined) produces the TEXT
      // "undefined" where Node produces the undefined VALUE (tsc's own lib
      // types the return `string`, so no static consumer can tell), and a
      // runtime handle inside the tree throws (Node would walk its own
      // enumerable props, which the handle does not model).
      if (!L.jsonSafe(value.type) && value.type.kind !== "dyn") {
        // Bare undefined-armed unions get their own wording: Node's
        // stringify of bare undefined is not a string at all — per-type
        // serialization cannot match that exactly, so the fence is
        // deliberate, not a gap. (Undefined-armed RECORD FIELDS pass the
        // fence: the field drops from the output, exactly Node.)
        if (L.bareUndefinedArmedUnion(value.type)) {
          L.unsupported(
            "SC1090",
            argNode,
            `JSON.stringify of '${L.fmt(value.type)}' values ` +
              `(Node's stringify of bare undefined is not a string at all — ` +
              `narrow with '!== undefined' first, model absence with a null arm, ` +
              `or use an optional record field ('{ a?: string }'), which drops ` +
              `from the output like Node's)`,
          );
        }
        L.unsupported(
          "SC1090",
          argNode,
          `JSON.stringify of '${L.fmt(value.type)}' values ` +
            `(only number, string, boolean, records, arrays, unions of those, and 'unknown' stringify)`,
        );
      }
      const node: IrExpr = { kind: "jsonStringify", value, type: STRING, loc };
      if (indent !== "") {
        // The compile-time-resolved indent rides as an extra property (the
        // node shape in ir/nodes.ts is unchanged); the backend re-indents
        // the compact serializer output with Node's gap algorithm.
        (node as { indent?: string }).indent = indent;
      }
      return node;
    }
    return null; // unknown members are tsc errors before lowering
  }

/** The compile-time indent of a `JSON.stringify(v[, replacer[, space]])`
   * call, with Node's space rules applied: a number clamps to 0–10 spaces
   * (ToInteger truncation), a string truncates to its first 10 code units,
   * and null/undefined/0/"" mean compact ("" here). Only literal
   * replacer/space spellings compile — the replacer must be `null` (or
   * `undefined`), the space a numeric/string literal or `null`/`undefined`;
   * everything else keeps the existing fence. */
  function stringifySpaceIndent(L: Lowerer, call: ts.CallExpression): string {
    const fence = (): never =>
      L.noLowering(
        "JSON.stringify with replacer/space parameters",
        call,
        "the serializer is type-directed — shape the value before stringifying",
      );
    if (call.arguments.length <= 1) return "";
    const unwrap = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
    const isUndefined = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) && e.text === "undefined";
    const replacer = unwrap(call.arguments[1]!);
    if (replacer.kind !== ts.SyntaxKind.NullKeyword && !isUndefined(replacer)) fence();
    if (call.arguments.length === 2) return "";
    const space = unwrap(call.arguments[2]!);
    if (space.kind === ts.SyntaxKind.NullKeyword || isUndefined(space)) return "";
    if (ts.isNumericLiteral(space)) {
      const n = Number(space.text.replace(/_/g, ""));
      return " ".repeat(Math.min(10, Math.max(0, Math.trunc(n))));
    }
    // A negative space literal (`-2`) clamps to 0 — compact, like Node.
    if (
      ts.isPrefixUnaryExpression(space) &&
      space.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(unwrap(space.operand))
    ) {
      return "";
    }
    if (ts.isStringLiteral(space) || ts.isNoSubstitutionTemplateLiteral(space)) {
      return space.text.slice(0, 10); // first 10 code units, like Node
    }
    fence();
    throw new InternalCompilerError("unreachable"); // fence() never returns
  }
