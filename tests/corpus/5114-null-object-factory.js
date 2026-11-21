// @ts-nocheck
const C = (() => {
  const C = function () {};
  C.prototype = Object.create(null);
  return C;
})();
const alias = C;
console.log(typeof C);
console.log(C === alias);
C();
const value = new C();
console.log(Object.getPrototypeOf(value) === C.prototype);
console.log(Object.getPrototypeOf(C.prototype) === null);
C.prototype.label = "shared";
console.log(String(value.label));
const previous = C.prototype;
C.prototype = Object.create(null);
const next = new C();
console.log(Object.getPrototypeOf(value) === previous);
console.log(Object.getPrototypeOf(next) === C.prototype);
console.log(Object.getPrototypeOf(next) === previous);
