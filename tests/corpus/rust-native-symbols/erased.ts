// @rust-only
// @no-engine
export {};
const token = Symbol('payload');
function describe(value: unknown): string { if (typeof value === 'symbol') return value.toString(); return typeof value; }
function identity(value: unknown): unknown { return value; }
const erased = identity(token);
console.log('erased', describe(erased), erased === token, describe({ token }), describe(1), describe(null));
try { throw token; } catch (error) { if (typeof error === 'symbol') console.log('caught', error === token); }
