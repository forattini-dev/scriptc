import { Envelope, envelope } from "native-declaration-abi";
const source = new Envelope(6);
const alias = envelope(source);
console.log("generic", alias === source, alias.value === 6);
source.value = 8;
console.log("live", envelope(alias) === source, alias.value === 8);
const strings = new Envelope("text");
console.log("separate", strings.value === "text", source.value === 8);
