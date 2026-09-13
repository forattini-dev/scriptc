import type { ShapeRegistry } from "./type-mapper.js";
import type { UnionRegistry } from "./union-registry.js";
import { accessorSlotProp, VOID, type IrType } from "../ir/ir.js";
import { InternalCompilerError } from "../errors.js";

/** Human-readable rendering of an IrType for diagnostics (records expand to
 * their canonical field list, unions to their arms; `checker.typeToString`
 * can't — it never sees IR types). `seen` breaks recursive shapes/unions:
 * a back-reference renders as "..." instead of expanding forever. */
export function formatIrType(t: IrType, shapes: ShapeRegistry, unions: UnionRegistry, seen: Set<string> = new Set()): string {
  switch (t.kind) {
    case "f64":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "dyn":
      return "unknown";
    case "caught":
      // What tsc calls the binding; the fence messages carry the real story.
      return "unknown";
    case "void":
      return "void";
    case "undefinedT":
      return "undefined";
    case "nullT":
      return "null";
    case "array": {
      // Union/func elements need the parens TS syntax would ("(number |
      // string)[]" — without them the [] reads as binding to the last arm).
      const elem = formatIrType(t.elem, shapes, unions, seen);
      return t.elem.kind === "union" || t.elem.kind === "func" ? `(${elem})[]` : `${elem}[]`;
    }
    case "bytes":
      // The u8 kind reads as Uint8Array (Buffer maps here too — one
      // runtime representation; the message stays honest either way).
      return t.elem === "u8" ? "Uint8Array" : t.elem === "u32" ? "Uint32Array" : t.elem === "i32" ? "Int32Array" : t.elem === "f32" ? "Float32Array" : "Float64Array";
    case "map":
      return `Map<${formatIrType(t.key, shapes, unions, seen)}, ${formatIrType(t.value, shapes, unions, seen)}>`;
    case "set":
      return `Set<${formatIrType(t.elem, shapes, unions, seen)}>`;
    case "func":
      return `(${t.params.map((p) => formatIrType(p, shapes, unions, seen)).join(", ")}) => ${formatIrType(t.ret, shapes, unions, seen)}`;
    case "object":
      // Runtime-provided error classes carry '%'-prefixed IR names
      // ("%Error") so user classes can never collide; diagnostics show the
      // source-level name.
      return t.className.startsWith("%") ? t.className.slice(1) : t.className;
    case "classval":
      // The static side, in TS's own spelling.
      return `typeof ${t.className.startsWith("%") ? t.className.slice(1) : t.className}`;
    case "record": {
      const shape = shapes.get(t.shapeId);
      if (!shape) return `{ /* unknown shape ${t.shapeId} */ }`;
      if (seen.has(t.shapeId)) return "..."; // the recursive knot
      seen.add(t.shapeId);
      try {
        if (shape.tuple) {
          const byIndex = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
          return `[${byIndex.map((f) => formatIrType(f.type, shapes, unions, seen)).join(", ")}]`;
        }
        const members = shape.fields.map((f) => {
          // Accessor slots print in TS's accessor spelling, not the
          // reserved '%'-field encoding.
          const slot = accessorSlotProp(f.name);
          if (slot && f.type.kind === "func") {
            return slot.kind === "get"
              ? `get ${slot.prop}(): ${formatIrType(f.type.ret, shapes, unions, seen)}`
              : `set ${slot.prop}(${formatIrType(f.type.params[0] ?? VOID, shapes, unions, seen)})`;
          }
          return `${f.name}: ${formatIrType(f.type, shapes, unions, seen)}`;
        });
        if (shape.indexValue) {
          members.push(`[key: string]: ${formatIrType(shape.indexValue, shapes, unions, seen)}`);
        }
        if (members.length === 0) return "{}";
        return `{ ${members.join("; ")} }`;
      } finally {
        seen.delete(t.shapeId); // sibling occurrences still expand
      }
    }
    case "union": {
      const def = unions.get(t.unionId);
      if (!def) return `/* union ${t.unionId} */`;
      if (seen.has(t.unionId)) return "..."; // the recursive knot
      seen.add(t.unionId);
      try {
        return def.arms.map((a) => formatIrType(a, shapes, unions, seen)).join(" | ");
      } finally {
        seen.delete(t.unionId);
      }
    }
    case "jsval":
      return "any";
    case "regex":
      return "RegExp";
    case "date":
      return "Date";
    case "url":
      return "URL";
    case "searchParams":
      return "URLSearchParams";
    case "symbol":
      return "symbol";
    case "stats":
      return "Stats";
    case "fileHandle":
      return "FileHandle";
    case "spawnRes":
      return "SpawnSyncReturns";
    case "child": return "ChildProcess";
    case "bigint": return "bigint"; case "effect": return "Effect"; case "genericFunc": return "generic function"; // opaque kernel handles (static builds): the effect handle's A/E are read at the boundaries, a family value's signature at its call sites
    case "netServer":
      return "Server";
    case "netSocket":
      return "Socket";
    case "http2Session":
      return "Http2Session";
    case "http2Stream":
      return "Http2Stream";
    case "dgramSocket":
      return "dgram.Socket";
    case "testCtx":
      return "TestContext";
    case "httpReq":
      return "IncomingMessage";
    case "httpRes":
      return "ServerResponse";
    case "httpClientReq":
      return "ClientRequest";
    case "secureCtx":
      return "SecureContext";
    case "fsWatcher":
      return "FSWatcher";
    case "childStream":
      return "Readable";
    case "procStream":
      return "WriteStream";
    case "promise":
      return `Promise<${formatIrType(t.inner, shapes, unions, seen)}>`;
    case "generator":
      return `Generator<${formatIrType(t.yieldT, shapes, unions, seen)}, ${formatIrType(t.retT, shapes, unions, seen)}, ${formatIrType(t.nextT, shapes, unions, seen)}>`;
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

