// @rust-only
// @no-engine
const first = /a/g;
const second = /b/g;
const test = first.test;
const alias = test;
console.log(test === alias, test === second.test, test === first.test);
const a = test.bind(first);
const b = alias.bind(second);
console.log(a === b, a("aba"), first.lastIndex, b("aba"), second.lastIndex);
console.log(a("aba"), first.lastIndex, a("aba"), first.lastIndex);
const rebound = a.bind(second);
console.log(rebound("aba"), first.lastIndex, second.lastIndex);
const prefix = test.bind(first, "aba");
console.log(prefix(), first.lastIndex);
