/* Native kernel and platform types in static builds: the runtime surfaces the type mapper does NOT map structurally.
 * effect's handles and schema values, service-key classes and native SqlClient values become the kernel's opaque
 * handle; effect brands strip and decorated schemas become records with a schema slot; bun:sqlite's Database and
 * Statement become native handles under --target bun. Dynamic builds map none of these here.
 *
 * The type mapper asks at three points, because each rule's place in its order matters:
 *  - mapKernelType, before the npm-package fence: bun-types and effect both ship declaration files, and a program
 *    interface extending SqlClient must win over the class and record rules;
 *  - mapKernelIntersection, first inside the intersection branch: brands strip before the package-intersection fence;
 *  - mapKernelServiceKey, just before class-instance mapping: a service key class is the key handle, not a class. */
import * as ts from "./ts7/adapter.js";
import { DYN, EFFECT_T, SQLITE_DB_T, SQLITE_STMT_T, type IrType } from "../ir/ir.js";
import { mapType, type TypeMapperCtx } from "./type-mapper.js";
import { decoratedSchemaRecord } from "./kernel-types.js";
import { isDeclaredInAmbientModule } from "./ambient-declarations.js";
import {
  isEffectDataHandleSymbol,
  isKernelHandleSymbol,
  isKernelSchemaValueSymbol,
  isNativeSqlClientType,
  kernelServiceIdOf,
  withoutKernelBrands,
} from "./kernel.js";

/** bun:sqlite's types: native Database/Statement handles; Changes/DatabaseOptions ride the checked-dynamic tree the
 * runtime builds. */
const BUN_SQLITE_TYPES: ReadonlyMap<string, IrType> = new Map([
  ["Database", SQLITE_DB_T],
  ["Statement", SQLITE_STMT_T],
  ["Changes", DYN],
  ["DatabaseOptions", DYN],
]);

/** The native type of a named kernel or platform type, or undefined when `widened` is not one. */
export function mapKernelType(widened: ts.Type, ctx: TypeMapperCtx): IrType | undefined {
  if (ctx.dynamic) return undefined;
  const checker = ctx.checker;
  const symbol = widened.getAliasSymbol() ?? widened.getSymbol();
  const decls = symbol === undefined ? undefined : checker.declarationsOf(symbol);
  // Effects, layers, exits, causes, options, schema values, filters and SchemaError: the kernel's opaque handle.
  if (symbol !== undefined && decls !== undefined) {
    if (isEffectDataHandleSymbol(symbol, decls) || isKernelSchemaValueSymbol(decls) || isKernelHandleSymbol(decls)) return EFFECT_T;
  }
  if (isNativeSqlClientType(checker, widened)) return EFFECT_T;
  if (symbol !== undefined && decls !== undefined && decls.some((d) => isDeclaredInAmbientModule(d as ts.Declaration, "bun:sqlite"))) {
    const sqlite = BUN_SQLITE_TYPES.get(symbol.name);
    if (sqlite !== undefined) return sqlite;
  }
  return undefined;
}

/** An intersection the kernel resolves: `string & Brand<"ID">` is its non-brand part, `Schema & { statics }` a record
 * with the schema slot (null when that part does not map). Undefined when the kernel has no rule for it. */
export function mapKernelIntersection(widened: ts.Type, ctx: TypeMapperCtx): IrType | null | undefined {
  if (ctx.dynamic) return undefined;
  const kept = withoutKernelBrands(ctx.checker, ts.constituentTypes(widened));
  if (kept.length === 1 && kept[0] !== undefined) return mapType(kept[0], ctx);
  return decoratedSchemaRecord(kept, ctx) ?? undefined;
}

/** A service key class (`class Native extends Context.Service<Native, T>()("id")`): instance and static sides are the
 * key handle. Undefined for any other declaration. */
export function mapKernelServiceKey(classDecl: ts.Node | undefined, ctx: TypeMapperCtx): IrType | undefined {
  if (ctx.dynamic || classDecl === undefined || !ts.isClassDeclaration(classDecl)) return undefined;
  return kernelServiceIdOf(ctx.checker, classDecl) !== null ? EFFECT_T : undefined;
}
