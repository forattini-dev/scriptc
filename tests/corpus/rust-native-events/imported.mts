import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {}

const bus = new Bus();
bus.once('tick', function (this: EventEmitter, value: unknown) {
  console.log(value, this === bus);
});
console.log(bus instanceof EventEmitter, bus.emit('tick', 4));
console.log(bus.emit('tick', 5));
