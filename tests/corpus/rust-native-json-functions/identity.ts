// @rust-only
// @no-engine
const write = JSON.stringify;
const alias = write;
const read = JSON.parse;
console.log("identity", write === alias, write === JSON.stringify, read === JSON.parse, (read as unknown) === (write as unknown));
console.log("types", typeof write, typeof read);
console.log("call", alias({value: 42}) === '{"value":42}', read("42") === 42);
