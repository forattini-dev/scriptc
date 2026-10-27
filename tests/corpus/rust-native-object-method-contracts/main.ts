// @rust-only
// @no-engine
export {};
import { renderer } from './lib/index.js';
const invert = renderer.invert;
console.log("method", renderer.invert("⠁⣿\nx😀"));
console.log("alias", invert("⠁⣿"));
console.log("arrow", renderer.double(3.5));
console.log("capture", renderer.nested("a😀"));
