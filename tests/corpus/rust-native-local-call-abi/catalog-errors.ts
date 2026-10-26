// @rust-only
// @no-engine
import {used, acceptsError} from "./catalog/index.js";

class Error { value = 7; }
console.log(used(1), used("x"), new Error().value);
console.log(acceptsError === acceptsError);
