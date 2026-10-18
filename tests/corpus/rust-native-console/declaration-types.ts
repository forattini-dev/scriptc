// @rust-only
// @no-engine
export {};
type StreamError = WritableStreamDefaultController["error"];
function forward(error: StreamError): void { error(7); }
forward((value: unknown): void => { if (typeof value === "number") { console.log("non-console error callback", value); } });
