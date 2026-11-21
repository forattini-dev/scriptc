// lodash-style UMD global detection: Node has `global` but no `self`.
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;
var root = freeGlobal || freeSelf || Function('return this')();

console.log(typeof self, typeof window, typeof root);
console.log(root === globalThis, freeSelf);

try {
  console.log(self.location);
} catch (error) {
  console.log(error instanceof ReferenceError, error.message);
}
try {
  console.log(window);
} catch (error) {
  console.log(error instanceof ReferenceError, error.message);
}
