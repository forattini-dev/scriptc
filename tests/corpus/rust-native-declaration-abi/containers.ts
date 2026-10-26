import { array, tuple } from "native-declaration-abi";
const values = [1, 2, 3];
const copy = array(values);
copy.push(4);
console.log("array", copy === values, values.join("|"));
const pair: [number, string] = [3, "three"];
const alias = tuple(pair);
console.log("tuple", alias === pair, alias[0], alias[1]);
