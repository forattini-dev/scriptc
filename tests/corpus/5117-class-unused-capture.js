// @ts-nocheck
const Factory = () => class {
  value() { return Later; }
};
const Class = Factory();
const instance = new Class();
let Later = 7;
console.log(instance.value());
