import { describe, expect, it } from "vitest";
import { canDynCheckTo } from "./ir.js";

describe("native RegExp receiver checks", () => {
  it("accepts a checked RegExp reference without requiring an engine", () => {
    expect(canDynCheckTo({ kind: "regex" }, () => undefined, () => undefined)).toBe(true);
  });
});
