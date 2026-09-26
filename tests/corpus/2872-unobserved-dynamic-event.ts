import { EventEmitter } from "node:events";

class Payload {
  readonly value = 42;
}

let nameCalls = 0;
function eventSuffix(): string {
  nameCalls++;
  return "add";
}

let payloadCalls = 0;
function payload(): Payload {
  payloadCalls++;
  return new Payload();
}

const emitter = new EventEmitter();
console.log(emitter.emit(`command:${eventSuffix()}`, payload()), nameCalls, payloadCalls);
