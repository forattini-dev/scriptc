// @rust-only
// @no-engine
const comment = /(?:^\uFEFF?|\n) *#/;
console.log("comments", comment.test("plain"), comment.test("# comment"), comment.test("\uFEFF # comment"), comment.test("ok\n  # comment"));
const url = /^[a-z][a-z0-9+.-]*:\/\//i;
console.log("url", url.test("HTTPS://native"), url.test("data:value"), url.flags, url.source);
const global = /a/g;
const alias = global;
console.log("global", global === alias, global.test("aba"), alias.lastIndex, alias.test("aba"), global.lastIndex, global.test("aba"), global.lastIndex);
global.lastIndex = 1;
console.log("reset", alias.test("aba"), alias.lastIndex);
const sticky = /a/y;
sticky.lastIndex = 1;
console.log("sticky", sticky.test("ba"), sticky.lastIndex, sticky.test("ba"), sticky.lastIndex);
function literal(): RegExp { return /a/g; }
const first = literal();
const second = literal();
console.log("fresh", first !== second, first.test("a"), second.lastIndex);
const constructed = new RegExp("^native$", "mi");
console.log("constructed", constructed.test("NATIVE"), constructed.flags, new RegExp("").source);
console.log("escaped source", new RegExp("/").source, new RegExp("[/]").source, new RegExp("\n").source, new RegExp("\u2028").source);
const unicode = /😀/u;
console.log("unicode", unicode.test("x😀"), unicode.source);
let effects = 0;
function receiver(): RegExp { effects = effects + 1; console.log("receiver", effects); return global; }
function subject(): string { global.lastIndex = 0; effects = effects + 1; console.log("subject", effects); return "a"; }
console.log("order", receiver().test(subject()), effects, global.lastIndex);
const patterns = [/x/g, /x/g];
const cell = { pattern: patterns[0] };
console.log("containers", patterns[0] !== patterns[1], cell.pattern === patterns[0], cell.pattern.test("x"), patterns[0].lastIndex, patterns[1].lastIndex);
