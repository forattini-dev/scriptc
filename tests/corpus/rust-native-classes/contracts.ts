// @rust-only
// @no-engine
import { Envelope, Payload } from "./library.mjs";
const envelope = new Envelope("native");
const Alias = Envelope;
class Child extends Envelope {}
const child = new Child("child");
console.log("contract", envelope.name, envelope.message, envelope.value);
console.log("child", child.name, child.message, child.value, child instanceof Envelope, child instanceof Child);
console.log("identity", Alias === Envelope, envelope instanceof Alias, envelope instanceof Error);
const data = { value: 42 };
const record = new Payload(data);
const scalar = new Payload("scalar");
console.log("generic", record.data === data, record.data.value, scalar.data, record instanceof Payload);
