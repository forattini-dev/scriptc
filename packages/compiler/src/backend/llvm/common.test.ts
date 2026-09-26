import { describe, expect, test } from "vitest";
import { llvmCommentText } from "./common.js";

describe("LLVM comment text", () => {
  test("preserves ordinary names and encodes control characters", () => {
    expect(llvmCommentText('quote"slash\\')).toBe('quote"slash\\');
    expect(llvmCommentText("line\n\0tab\tunit\u001f\u007f\u0085\u2028")).toBe(
      "line\\u000a\\u0000tab\\u0009unit\\u001f\\u007f\\u0085\\u2028",
    );
  });
});
