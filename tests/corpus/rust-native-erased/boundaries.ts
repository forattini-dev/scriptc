import { publicAny, overloaded, generic } from "./api.js";
import { indirect } from "./facade.js";
console.log("public", publicAny(2), overloaded(2), overloaded("word"), generic("generic"));
console.log("indirect", indirect("resolved"));
