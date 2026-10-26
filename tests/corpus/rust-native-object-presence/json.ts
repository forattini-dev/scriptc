// @ts-nocheck
// @rust-only
// @no-engine
const document = JSON.parse('{"nested":{"$value":null},"__proto__":{"polluted":true},"toString":null}');
const nested = document.nested;
console.log("parsed", "$value" in nested, "missing" in nested, "constructor" in nested, Object.hasOwn(nested, "constructor"));
console.log("proto-key", "__proto__" in document, Object.hasOwn(document, "__proto__"), "polluted" in document);
console.log("shadow", "toString" in document, Object.hasOwn(document, "toString"));
delete document.toString;
console.log("unshadow", "toString" in document, Object.hasOwn(document, "toString"));
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function token(value: unknown): boolean { return isObject(value) && "$value" in value; }
console.log("guard", token(nested), token({}), token(null), token([]));
