/// <reference types="node" />
import { isDeepStrictEqual } from "node:util";

const left = {
  profile: {
    resources: [
      { name: "compiler", enabled: true, limits: [1, 2, Number.NaN] },
      { name: "runtime", enabled: false, limits: [] },
    ],
  },
};
const same = {
  profile: {
    resources: [
      { name: "compiler", enabled: true, limits: [1, 2, Number.NaN] },
      { name: "runtime", enabled: false, limits: [] },
    ],
  },
};
const changed = {
  profile: {
    resources: [
      { name: "compiler", enabled: true, limits: [1, 3, Number.NaN] },
      { name: "runtime", enabled: false, limits: [] },
    ],
  },
};

console.log(isDeepStrictEqual(left, same));
console.log(isDeepStrictEqual(left, changed));
console.log(isDeepStrictEqual([undefined], new Array(1)));
