

/** The ambient TYPE names of the fetch slice. Under --dynamic their
 * values live in the embedded engine and map to island handles (jsval).
 * Static fetch gives Response, RequestInit, AbortController/AbortSignal, response
 * Headers, and the readable Web Streams slice native checked-dynamic
 * handle representations. The Headers constructor itself remains
 * dynamic-only even though response.headers is native.
 * Declaration provenance is checked in mapType so user types with the
 * same names keep their ordinary structural representation. */
export const ISLAND_AMBIENT_TYPES = [
  "Request",
  "Response",
  "ResponseInit",
  "RequestInit",
  "Event",
  "EventTarget",
  "AbortController",
  "AbortSignal",
  "Headers",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "ReadableStreamDefaultController",
  "ReadableStreamReadResult",
  "ReadableStreamReadValueResult",
  "ReadableStreamReadDoneResult",
  "ReadableStreamDefaultReadResult",
  "ReadableStreamDefaultReadValueResult",
  "ReadableStreamDefaultReadDoneResult",
] as const;

/** node:util.parseArgs's public and @types/node helper type names. Values
 * behind this surface use the checked-dynamic tree; see mapTypeInner. */
export const PARSE_ARGS_DYN_TYPES = new Set([
  "ParseArgsConfig",
  "ParseArgsOptionDescriptor",
  "ParseArgsOptionsConfig",
  "ParseArgsResult",
  "ParseArgsToken",
  "ParsedResults",
  "PreciseParsedResults",
  "ParsedValues",
  "ParsedPositionals",
  "ParsedTokens",
  "ParsedOptionToken",
  "ParsedPositionalToken",
  "PreciseTokenForOptions",
  "TokenForOptions",
  "OptionToken",
  "Token",
]);

/** True for the parseArgs type family that deliberately rides dyn. Exported
 * for the property-read bridge after TypeScript narrows a token union arm. */
export function isParseArgsDynTypeName(name: string): boolean {
  return PARSE_ARGS_DYN_TYPES.has(name);
}
