// @rust-only
// @no-engine
import * as crypto from "node:crypto";
import { randomUUID as uuid } from "node:crypto";
const first = crypto.randomUUID();
const second = uuid();
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
console.log("uuid", first.length, second.length, uuid4.test(first), uuid4.test(second));
console.log("version", first.charAt(14), second.charAt(14), first !== second);
