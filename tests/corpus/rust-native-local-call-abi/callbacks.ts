// @rust-only
// @no-engine
export {};
function maybe(value: boolean): number | undefined { if (value) return 3; }
const callback: (value: boolean) => number | undefined = value => { if (value) return 5; };
const bare: (value: boolean) => number | undefined = value => { if (value) return; return 8; };
console.log("optional", String(maybe(true)), String(maybe(false)));
console.log("callbacks", String(callback(true)), String(callback(false)), String(bare(true)), String(bare(false)));
