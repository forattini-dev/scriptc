import { describe, expect, test } from "vitest";
import { jsonObjectKeyLabel, jsonStringToken } from "./json-literal.js";

describe("JSON object-key labels", () => {
  test("escapes quotes, backslashes, controls, and lone surrogates", () => {
    expect(jsonObjectKeyLabel('q"q')).toBe('"q\\"q":');
    expect(jsonObjectKeyLabel("a\\nb")).toBe('"a\\\\nb":');
    expect(jsonObjectKeyLabel("\0\b\f\n\r\t\u001f")).toBe('"\\u0000\\b\\f\\n\\r\\t\\u001f":');
    expect(jsonObjectKeyLabel("\ud800")).toBe('"\\ud800":');
  });

  test("leaves valid Unicode text intact", () => {
    expect(jsonObjectKeyLabel("héllo 日本語 😀")).toBe('"héllo 日本語 😀":');
  });

  test("provides escaped standalone string tokens", () => {
    expect(jsonStringToken("line\n\0tab\t")).toBe('"line\\n\\u0000tab\\t"');
  });
});
