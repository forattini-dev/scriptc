const own = {
  [Symbol.iterator](): Iterator<number> {
    return [1][Symbol.iterator]();
  },
  text: "yes",
};

class Inherited {
  [Symbol.iterator](): Iterator<number> {
    return [2][Symbol.iterator]();
  }
}

const inherited = new Inherited();
console.log(
  Object.prototype.hasOwnProperty.call(own, Symbol.iterator),
  Object.prototype.hasOwnProperty.call(own, "text"),
  Object.prototype.hasOwnProperty.call(inherited, Symbol.iterator),
);
console.log(Object.hasOwn(own, Symbol.iterator), Object.hasOwn(inherited, Symbol.iterator));
