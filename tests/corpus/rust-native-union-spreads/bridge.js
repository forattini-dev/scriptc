export function pass(p) { return p; }
export function inspect(p) { return Object.keys(p).join("|") + (p.flag === true ? ":true" : ":false"); }
export function optionalCopy(p) { return { ...p }; }
