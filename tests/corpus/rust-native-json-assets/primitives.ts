// @rust-only
// @no-engine
import number from "./negative-zero.json" with {type: "json"};
import flag from "./flag.json" with {type: "json"};
import nil from "./nil.json" with {type: "json"};
console.log("primitives", 1 / number === Number.NEGATIVE_INFINITY, flag, nil === null);
