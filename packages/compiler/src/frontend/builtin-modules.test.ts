import { expect, test } from "vitest";
import { isKernelModule } from "./builtin-modules.js";

test("kernel subpaths preserve package boundaries", () => {
  for (const spec of ["effect", "effect/Effect", "effect/Option", "effect/unstable/http"]) {
    expect(isKernelModule(spec), spec).toBe(true);
  }
  for (const spec of ["effective", "effect-extra", "effect-extra/Effect", "@scope/effect", "./effect/Effect"]) {
    expect(isKernelModule(spec), spec).toBe(false);
  }
});
