// @rust-only
// @no-engine
// @npm-static: auto
import { make, slots, captureDefault } from "native-rest-entry";
const object = { value: 42 };
const alias = slots;
console.log("identity", alias(1, 2, object) === object);
const next = make("own");
console.log("capture", String(next()), String(next()));
const other = make("other");
console.log("separate", String(next()), String(other()));
const defaultClosure = captureDefault();
console.log("default-capture", String(defaultClosure()), String(defaultClosure()));
