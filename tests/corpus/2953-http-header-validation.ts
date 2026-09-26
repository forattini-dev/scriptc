import * as http from "node:http";
import { validateHeaderName, validateHeaderValue } from "node:http";

function result(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof Error) {
      return `${error.name}:${(error as NodeJS.ErrnoException).code}:${error.message}`;
    }
    return "unexpected error";
  }
}

const dynamicName = "X-Valid_09";
console.log("name", result(() => validateHeaderName(dynamicName)));
console.log("token", result(() => http.validateHeaderName("!#$%&'*+-.^_`|~")));
console.log("empty-name", result(() => validateHeaderName("")));
console.log("space-name", result(() => http.validateHeaderName("Bad Name", "Field name")));
console.log("colon-name", result(() => validateHeaderName("Bad:Name")));
console.log("unicode-name", result(() => validateHeaderName("Café")));
console.log("empty-label", result(() => validateHeaderName("bad name", "")));

console.log("empty-value", result(() => validateHeaderValue("x-test", "")));
console.log("tab-value", result(() => http.validateHeaderValue("x-test", "a\tb")));
console.log("latin1-value", result(() => validateHeaderValue("x-test", "café\u00ff")));
console.log("number-value", result(() => validateHeaderValue("x-test", 42)));
console.log("boolean-value", result(() => validateHeaderValue("x-test", true)));
console.log("null-value", result(() => validateHeaderValue("x-test", null)));
console.log("array-value", result(() => validateHeaderValue("x-test", [1, 2])));
console.log("undefined-value", result(() => validateHeaderValue("x-test", undefined)));
console.log("newline-value", result(() => validateHeaderValue("x-test", "a\nb")));
console.log("del-value", result(() => validateHeaderValue("x-test", "a\u007fb")));
console.log("wide-value", result(() => validateHeaderValue("x-test", "a\u0100b")));
console.log("unchecked-name", result(() => validateHeaderValue("bad name", "valid")));
