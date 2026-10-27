// @rust-only
// @no-engine
// @ts-nocheck
export {};
const text = Buffer.from("tést😀");
console.log("string", text.length, text.toString(), text.toString("hex"), text.toString("base64"), Buffer.isBuffer(text));
console.log("aliases", Buffer.from("ab", "UTF-16LE").toString("HEX"), Buffer.from("é", "binary").toString("latin1"));
console.log("decode", Buffer.from("YWI=", "base64").toString(), Buffer.from("1ag123", "hex").toString("hex"));
console.log("defaults", Buffer.from("ab", undefined).toString(undefined), Buffer.from("ab", null).toString(), Buffer.from("ab", "").toString());
const array = Buffer.from([257, -1, 3.9, Number.NaN, Number.POSITIVE_INFINITY]);
console.log("array", array.toString("hex"), Buffer.isBuffer(array));
console.log("tuple", Buffer.from([1, 258, 3] as const).toString("hex"));
const plain = new Uint8Array([65, 66]);
const copy = Buffer.from(plain);
plain.set(new Uint8Array([90]));
console.log("copy", copy.toString(), copy === plain, Buffer.isBuffer(copy), Buffer.isBuffer(plain), plain.toString());
const second = Buffer.from(copy);
copy.set(new Uint8Array([88]));
console.log("independent", second.toString(), copy.toString());
const erased: any = JSON.parse('["2",null,true,3.9]');
console.log("dynamic", Buffer.from(erased).toString("hex"));
console.log("array-like", Buffer.from({0: 65, 1: 66, length: 2}).toString(), Buffer.from({length: "2"}).length);
console.log("json", Buffer.from({type: "Buffer", data: [65, 66]}).toString());
const view = second.subarray(1);
view.set(new Uint8Array([89]));
console.log("view", Buffer.isBuffer(view), second.toString());
console.log("cast", (plain as unknown as Buffer).toString("hex"));
