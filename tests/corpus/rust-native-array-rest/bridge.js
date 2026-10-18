export function make(prefix) { return (...parts) => prefix + ":" + parts.join("|"); }
export const gather = (...parts) => parts;
export function record(prefix, ...parts) { return { prefix, parts }; }
