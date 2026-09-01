import { empty, readType } from "optionszoo";

const options = empty();
const name = "json";
options[name] = { type: "boolean" };
console.log(readType(options, name));
