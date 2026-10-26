// @ts-nocheck
// @rust-only
// @no-engine
import text from "./text.json" with {type: "json"};
import array from "./array.json" with {type: "json"};
import same from "./array.json" with {type: "json"};
import zero from "./negative-zero.json" with {type: "json"};
const alias = zero;
const words = text;
console.log("scalars", words, 1 / alias === Number.NEGATIVE_INFINITY);
console.log("array", array === same, Array.isArray(array), array.length === 3, array[1].name === "nested", array[2] === null);
array[1].name = "changed";
array[0] = 4;
console.log("shared", same[0] === 4, same[1].name === "changed");
