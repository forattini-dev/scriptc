"use strict";

const { stringify } = require("node:querystring");

const query = {
  text: "a b&c=é",
  count: 42,
  yes: true,
  huge: 12n,
  many: ["x y", 2, false, null],
  nil: null,
  missing: undefined,
  nested: { x: 1 },
  nan: NaN,
  inf: Infinity,
  empty: [],
};

console.log(stringify(query));
