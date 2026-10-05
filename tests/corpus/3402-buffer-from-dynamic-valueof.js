// @rust-only
// @no-engine
function copy(value) { return Buffer.from(value).toString('hex'); }
function textValue() { return this.text; }
function selfValue() { return this; }
console.log(copy({ text: 'π', valueOf: textValue }));
console.log(copy({ valueOf() { return [257, -1]; } }));
console.log(copy({ 0: 9, length: 1, valueOf: selfValue }));
console.log(copy({ 0: 7, length: 1, valueOf() { return 42; } }));
console.log(copy({ 0: 5, length: 1, valueOf: false }));
try { copy({ length: 1, valueOf: true }); } catch (error) { console.log(error.name, error.message); }
