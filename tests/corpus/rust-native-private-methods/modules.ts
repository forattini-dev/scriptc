// @rust-only
// @no-engine
import { Imported, Named } from "./dependency.ts";
const Alias = Imported;
console.log(new Alias().value(), new Named().value());
