"use strict";

const webidl = {
  brandCheck() {},
  argumentLengthCheck() {},
};

function iteratorMixin(name, object, makeIterator) {
  const properties = {
    forEach: {
      writable: true,
      enumerable: true,
      configurable: true,
      value: function forEach(callbackfn, thisArg = globalThis) {
        webidl.brandCheck(this, object);
        webidl.argumentLengthCheck(arguments, 1, `${name}.forEach`);
        if (typeof callbackfn !== "function") {
          throw new TypeError(
            `Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`,
          );
        }
        for (const { 0: key, 1: value } of makeIterator(this, "key+value")) {
          callbackfn.call(thisArg, value, key, this);
        }
      },
    },
  };
  return Object.defineProperties(object.prototype, properties);
}

module.exports = { iteratorMixin };

const probe = {
  value: function (first, second = globalThis) {
    return `${arguments.length}:${first}:${second === globalThis}`;
  },
};
console.log(probe.value("one", undefined));
console.log(probe.value("one", "two"));
