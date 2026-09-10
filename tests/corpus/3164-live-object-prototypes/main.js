// @dynamic
// @island-module: ./prototype.js
import { prototype, addProperty } from "./prototype.js";

const grab = (...args) => args[0];
const native = grab({ tag: 7 });
let calls = 0;
function getPrototype() { calls++; return native; }
const child = Object.create(getPrototype());
const grandchild = Object.create(child);
const alias = native;
alias.added = "native";
console.log(calls, `${child.added}`, `${grandchild.added}`);
child.tag = 99;
console.log(`${native.tag}`, `${child.tag}`, `${grandchild.tag}`);
alias.added = "updated";
console.log(`${grandchild.added}`, JSON.stringify(child), JSON.stringify(grandchild));
native.tag = 8;
console.log(`${native.tag}`, `${child.tag}`, `${grandchild.tag}`);

const engineChild = Object.create(prototype);
addProperty();
console.log(`${engineChild.added}`, `${engineChild.tag}`, JSON.stringify(engineChild));
engineChild.tag = 42;
console.log(`${prototype.tag}`, `${engineChild.tag}`, JSON.stringify(engineChild));

const dictionary = Object.create(null);
dictionary.x = 1;
console.log(JSON.stringify(dictionary));
