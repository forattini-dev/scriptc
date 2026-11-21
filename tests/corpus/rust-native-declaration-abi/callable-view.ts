import { change, exposed, original, same } from "callable-view";
console.log("call", exposed("ok"));
console.log("identity", exposed === original, same());
console.log("getter", String(exposed.info), String(original.info));
console.log("change", String(change()), String(exposed.label), String(original.label));
