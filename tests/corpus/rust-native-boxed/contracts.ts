// @rust-only
// @no-engine
console.log("number", new Number().valueOf(), new Number(undefined).valueOf(), new Number(null).valueOf(), new Number(" 0x10 ").valueOf(), new Number(true).valueOf());
console.log("special", 1 / new Number(-0).valueOf(), new Number(0 / 0).valueOf());
console.log("string", new String().valueOf(), new String(undefined).valueOf(), new String(null).valueOf(), new String(false).valueOf(), new String(12).valueOf());
console.log("boolean", new Boolean().valueOf(), new Boolean(false).valueOf(), new Boolean("false").valueOf(), new Boolean({n: 1}).valueOf());
const high = "😀".slice(0, 1); const wrapped = new String(high);
console.log("utf16", wrapped.valueOf() === high, wrapped.valueOf().length, wrapped.valueOf().charCodeAt(0));
const zero = new Number(0); const empty = new String(""); const no = new Boolean(false);
console.log("objects", typeof zero, typeof empty, typeof no, !!zero, !!empty, !!no);
const primitive: Number = 4;
const primitiveText: String = "text";
const primitiveBool: Boolean = false;
console.log("interface", primitive.valueOf(), primitiveText.valueOf(), primitiveBool.valueOf());
