import { tag, wrapped } from "./proxied.js";
import { readWeird } from "./blocked2.js";

console.log(tag("x"), wrapped.answer, readWeird());
