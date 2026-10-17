// @rust-only
// @no-engine
export {};
class Error { message = 42; }
class Child extends Error { name = false; }
const local = new Error();
const child = new Child();
console.log("shadow", local.message, local instanceof Error, child.message, child.name, child instanceof Error);
