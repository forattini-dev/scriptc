import { expect, test } from "vitest";
import { type IrFunction, type IrGlobal, type IrModule, VOID } from "./ir.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { validateModule } from "./validate.js";

const loc = { file: "native-module.ts", start: 0, end: 1 };
const cache: IrGlobal = { id: "%g.cache", name: "cache", type: { kind: "promise", inner: VOID }, mutable: true };
const init: IrFunction = {
  name: "%init", params: [], locals: [], returnType: VOID,
  syncModuleCacheGlobal: cache.id, body: [], loc,
};

function moduleWith(fn: IrFunction = init, globals: IrGlobal[] = [cache]): IrModule {
  return { irVersion: 8, sourceFile: loc.file, entry: fn.name, globals, functions: [fn] };
}

test("synchronous native module caches validate and survive serialization", () => {
  const mod = moduleWith();
  expect(validateModule(mod)).toEqual([]);
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("synchronous module caches require a mutable Promise<void> global", () => {
  expect(validateModule(moduleWith(init, []))).toEqual([
    { message: 'in %init: sync module cache names undeclared global "%g.cache"', loc },
  ]);
  expect(validateModule(moduleWith(init, [{ ...cache, mutable: false }]))).toEqual([
    { message: 'in %init: sync module cache global "%g.cache" is immutable', loc },
  ]);
  expect(validateModule(moduleWith(init, [{ ...cache, type: { kind: "bool" } }]))).toEqual([
    { message: expect.stringContaining('sync module cache global "%g.cache" has type bool'), loc },
  ]);
});

test("synchronous cache metadata refuses async and value-returning functions", () => {
  for (const fn of [{ ...init, async: true as const }, { ...init, returnType: { kind: "f64" } as const }]) {
    expect(validateModule(moduleWith(fn)).map((error) => error.message)).toContain(
      "in %init: a syncModuleCacheGlobal requires a synchronous void initializer without parameters or captures",
    );
  }
});
