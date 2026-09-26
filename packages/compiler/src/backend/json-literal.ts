import { InternalCompilerError } from "../errors.js";

/** A complete quoted JSON string token in runtime bytes. */
export function jsonStringToken(value: string): string {
  const token = JSON.stringify(value);
  if (token === undefined) {
    throw new InternalCompilerError("JSON.stringify unexpectedly omitted a string value");
  }
  return token;
}

/** A complete JSON object-key label (`"escaped key":`) in runtime bytes.
 * Backends still have to encode this text as a C or LLVM string constant;
 * this layer owns JSON escaping so those host-literal encoders never receive
 * an unquoted property name. */
export function jsonObjectKeyLabel(name: string): string {
  return `${jsonStringToken(name)}:`;
}
