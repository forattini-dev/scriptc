import { expect, test } from "vitest";
import type * as ts from "../ts7/adapter.js";
import type { IrLocal, IrType } from "../../ir/ir.js";
import { ScopeEnv, newFnCtx, type ScopeEnvHooks } from "./scope-env.js";

const F64: IrType = { kind: "f64" };
const OBJ: IrType = { kind: "object", className: "Point" };

/** A binding key: the environment only compares symbols by identity. */
const symbol = (name: string): ts.Symbol => ({ escapedName: name }) as unknown as ts.Symbol;

function makeEnv(hooks: Partial<ScopeEnvHooks> = {}) {
  const threaded: [string, string][] = [];
  const refusals: string[] = [];
  const env = new ScopeEnv({
    predeclare: () => false,
    captureThreaded: (parent, entry) => threaded.push([parent.id, entry.id]),
    refuse: (_symbol, _blame, message) => {
      refusals.push(message);
      throw new Error(message);
    },
    ...hooks,
  });
  return { env, threaded, refusals };
}

const plainFunction = () => newFnCtx(false, null, null, F64);
const liftedFunction = () => newFnCtx(true, null, null, F64);

test("declares, shadows in a block scope, and drops the block scope afterwards", () => {
  const { env } = makeEnv();
  const x = symbol("x");
  env.inFunction(plainFunction(), () => {
    const outer = env.declare(x, "x", F64, true);
    expect(outer.id).toBe("x.0");
    env.inScope(() => {
      const inner = env.declare(x, "x", F64, false);
      expect(inner.id).toBe("x.1");
      expect(env.resolve(x)).toBe(inner);
    });
    expect(env.resolve(x)).toBe(outer);
    expect(env.current.locals.map((local) => local.id)).toEqual(["x.0", "x.1"]);
  });
  expect(env.frames).toHaveLength(0);
});

test("scopes and functions are left even when their body throws", () => {
  const { env } = makeEnv();
  const outer = plainFunction();
  env.inFunction(outer, () => {
    expect(() => env.inScope(() => {
      throw new Error("lowering failed");
    })).toThrow("lowering failed");
    expect(outer.scopes).toHaveLength(1);
    expect(() => env.inFunction(liftedFunction(), () => {
      throw new Error("nested failed");
    })).toThrow("nested failed");
    expect(env.frames).toEqual([outer]);
  });
  expect(env.frames).toHaveLength(0);
});

test("a scope can open with bindings already in place", () => {
  const { env } = makeEnv();
  const param = symbol("param");
  env.inFunction(plainFunction(), () => {
    const caught = env.declareHidden("%caught", F64);
    expect(env.inScope(() => env.resolve(param), [[param, caught]])).toBe(caught);
    expect(env.resolve(param)).toBeNull();
  });
});

test("a binding from an enclosing function is boxed at its origin and threaded through every lifted function", () => {
  const { env, threaded } = makeEnv();
  const x = symbol("x");
  env.inFunction(plainFunction(), () => {
    const origin = env.declare(x, "x", F64, true);
    const middle = liftedFunction();
    const inner = liftedFunction();
    env.inFunction(middle, () => env.inFunction(inner, () => {
      const entry = env.resolve(x)!;
      expect(entry).not.toBe(origin);
      expect(entry.boxed).toBe(true);
      expect(env.resolve(x)).toBe(entry);
    }));
    expect(origin.boxed).toBe(true);
    expect(middle.captures?.map((capture) => capture.localId)).toEqual(["x.0"]);
    expect(middle.captureSources).toEqual(["x.0"]);
    expect(inner.captures?.map((capture) => capture.localId)).toEqual(["x.0"]);
    expect(inner.captureSources).toEqual([middle.captureBySymbol.get(x)!.id]);
    expect(threaded).toEqual([["x.0", "x.0"], ["x.0", "x.0"]]);
  });
});

test("a plain function between the origin and the reference refuses the capture", () => {
  const { env, refusals } = makeEnv();
  const x = symbol("x");
  env.inFunction(plainFunction(), () => {
    env.declare(x, "x", F64, false);
    env.inFunction(plainFunction(), () => {
      expect(() => env.resolve(x)).toThrow();
    });
  });
  expect(refusals[0]).toContain("captured through a plain nested function");
});

test("a catch binding never escapes into a closure", () => {
  const { env, refusals } = makeEnv();
  const error = symbol("error");
  env.inFunction(plainFunction(), () => {
    env.declare(error, "error", { kind: "caught" }, false);
    env.inFunction(liftedFunction(), () => {
      expect(() => env.resolve(error)).toThrow();
    });
  });
  expect(refusals[0]).toContain("catch bindings");
});

test("`this` resolves through arrows, and withThis rebinds it only inside its body", () => {
  const { env } = makeEnv();
  env.inFunction(plainFunction(), () => {
    const receiver = env.declareThis(OBJ);
    expect(env.resolveThis()).toBe(receiver);
    const self = env.declareHidden("%self", OBJ);
    env.inFunction(liftedFunction(), () => {
      const captured = env.resolveThis()!;
      expect(captured.name).toBe("this");
      expect(captured.boxed).toBe(true);
    });
    env.withThis(self, () => {
      env.inFunction(liftedFunction(), () => {
        expect(env.resolveThis()?.name).toBe("%self");
      });
    });
    expect(env.resolveThis()).toBe(receiver);
  });
});

test("a missed binding asks the predeclare hook and resolves what it declared", () => {
  const late = symbol("late");
  let asked = 0;
  const { env } = makeEnv({
    predeclare: (missed) => {
      asked++;
      if (missed !== late) return false;
      env.declare(late, "late", F64, false);
      return true;
    },
  });
  env.inFunction(plainFunction(), () => {
    expect(env.resolve(symbol("unknown"), {} as ts.Node)).toBeNull();
    expect(env.resolve(late)).toBeNull(); // no blame node: no predeclaring
    const resolved = env.resolve(late, {} as ts.Node);
    expect(resolved?.name).toBe("late");
  });
  expect(asked).toBe(2);
});

test("peek answers the nearest binding without creating captures", () => {
  const { env } = makeEnv();
  const x = symbol("x");
  env.inFunction(plainFunction(), () => {
    const origin = env.declare(x, "x", F64, false);
    const nested = liftedFunction();
    env.inFunction(nested, () => {
      expect(env.peek(x)).toBe(origin);
      expect(env.originOf(x)).toBe(origin);
    });
    expect(origin.boxed).toBeFalsy();
    expect(nested.captures).toEqual([]);
  });
});

test("inOwnerEnvironment lowers under an enclosing frame and restores both stacks", () => {
  const { env } = makeEnv();
  const owner = plainFunction();
  const nested = liftedFunction();
  const hoisted = symbol("hoisted");
  env.inFunction(owner, () => {
    const listFrame = env.innermostScope;
    env.inScope(() => {
      env.inFunction(nested, () => {
        expect(env.isOpen(owner, listFrame)).toBe(true);
        env.inOwnerEnvironment(owner, listFrame, () => {
          expect(env.current).toBe(owner);
          expect(env.innermostScope).toBe(listFrame);
          env.declare(hoisted, "hoisted", F64, false);
        });
        expect(env.current).toBe(nested);
        expect(owner.scopes).toHaveLength(2);
        expect(env.resolve(hoisted)?.boxed).toBe(true);
      });
    });
  });
});

test("reading the current function with no function open is a lowerer bug", () => {
  const { env } = makeEnv();
  expect(() => env.current).toThrow("no active function context");
  expect(env.inFunction(plainFunction(), () => env.frames.length)).toBe(1);
  const local: IrLocal = { id: "y.0", name: "y", type: F64, mutable: false };
  expect(() => env.withThis(local, () => 0)).toThrow("no active function context");
});
