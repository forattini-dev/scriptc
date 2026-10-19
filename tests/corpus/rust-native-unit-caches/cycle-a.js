import "./cycle-b.js";
export let cache = null;
export function read() { return cache === null; }
export function write(value) { cache = value; return true; }
