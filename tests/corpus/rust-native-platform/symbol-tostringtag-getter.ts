class Tagged {
  get [Symbol.toStringTag]() {
    return "Tagged";
  }
}

const tagged = new Tagged();
console.log(tagged[Symbol.toStringTag], Object.prototype.toString.call(tagged));
