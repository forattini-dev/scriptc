// @rust-only
// @no-engine
import { ExportedFault as ImportedFault } from "./reexports.ts";
const items = ["one", "two"];
const imported = new ImportedFault("imported", items);
console.log("imported", imported.name, imported.message, imported.items === items, imported.items[1], imported instanceof SyntaxError, imported instanceof ImportedFault);
class ForwardedFault extends ImportedFault {}
const forwarded = new ForwardedFault("forwarded", items);
console.log("forwarded", forwarded.name, forwarded.items === items, forwarded instanceof ImportedFault);
class LinkError extends Error {
  peer: Error | undefined;
  constructor(message: string) { super(message); }
}
const first = new LinkError("first");
const second = new LinkError("second");
console.log("unset", first.peer === undefined);
first.peer = second;
second.peer = first;
const peer = first.peer;
if (peer !== undefined) console.log("cycle", peer.message, peer === second, peer instanceof LinkError);
const stored: Error[] = [first, second];
console.log("array", stored[0] === first, stored[1].message);
class BaseField extends Error {
  value: number | undefined = 42;
  constructor() { super(); }
}
class RedefinedField extends BaseField { value: number | undefined = undefined; }
const redefined = new RedefinedField();
console.log("redefined", redefined.value === undefined);
class OptionalError extends TypeError { constructor(message?: string) { super(message); } }
const omitted = new OptionalError();
const supplied = new OptionalError("supplied");
console.log("optional", omitted.name, omitted.message === "", supplied.message, omitted instanceof TypeError);
const asError: Error = imported;
console.log("mixed identity", asError === imported, asError !== first, asError !== new SyntaxError("imported"));
