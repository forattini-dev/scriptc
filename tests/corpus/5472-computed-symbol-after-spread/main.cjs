"use strict";

const properties = {
  entries: {
    writable: true,
    enumerable: true,
    configurable: true,
    value: function entries() {
      return "ok";
    },
  },
};

const descriptors = {
  ...properties,
  [Symbol.iterator]: {
    writable: true,
    enumerable: false,
    configurable: true,
    value: properties.entries.value,
  },
};

const target = {};
Object.defineProperties(target, descriptors);

console.log(target.entries());
console.log(target[Symbol.iterator]());
console.log(Object.keys(target).join(","));
console.log(Object.getOwnPropertySymbols(target).length);
console.log(Object.getOwnPropertyDescriptor(target, Symbol.iterator).enumerable);

