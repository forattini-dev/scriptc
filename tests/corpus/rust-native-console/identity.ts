// @rust-only
// @no-engine
export {};
const alias = console.log;
const error = console.error;
function identity(sink: (message: string) => void): (message: string) => void { return sink; }
const holder = { sink: alias };
console.log("identity", alias === console.log, identity(console.log) === alias, holder.sink === console.log);
console.log("distinct", console.log === console.info, console.log === console.debug, console.warn === console.error, alias === error);
const erased: unknown = alias;
const checked = erased as (message: string) => void;
console.log("erased", checked === console.log, typeof alias);
checked("checked sink");
const bound: () => void = console.log.bind(null, "bound sink");
bound();
let optional: ((message: string) => void) | null = console.warn;
if (optional) { optional("optional warning"); }
