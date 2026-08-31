// V8's structured stack frames under the island (Error.prepareStackTrace's
// CallSite objects) — the http-errors module-init crash.
//
// http-errors calls `require('depd')('http-errors')` at module scope; depd
// walks the structured stack and calls `callSite.isEval()`. quickjs-ng's
// CallSite carries only the accessors its own trace text needs, so isEval
// was undefined and every package under http-errors (express, router,
// send, body-parser, serve-static) died with "not a function" at load.
// callsitezoo reproduces that init shape: the same stack walk, the same
// inherits + setPrototypeOf error hierarchy over Error.
//
// Receiver-derived answers (getTypeName, isToplevel) are NOT compared —
// the island does not retain a frame's receiver. Everything else is.
import {
  deprecateNamespace,
  deprecateFileIsString,
  deprecateMessage,
  describeFrame,
  frameValues,
  NotFoundError,
  InternalServerError,
  describeError,
} from "callsitezoo";

// The module reached its exports at all: the regression itself.
console.log(`${deprecateNamespace}`);
console.log(`${deprecateFileIsString}`);
console.log(`${deprecateMessage}`);

// Every V8 CallSite accessor exists and is callable without throwing.
for (const line of describeFrame()) console.log(`${line}`);

// The receiver-independent frame values.
for (const line of frameValues()) console.log(`${line}`);

// inherits + setPrototypeOf over Error: message, status, and the whole
// instanceof chain.
console.log(`${describeError(NotFoundError())}`);
console.log(`${describeError(NotFoundError("gone missing"))}`);
console.log(`${describeError(InternalServerError("boom"))}`);
