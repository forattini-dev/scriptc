import { EventEmitter } from 'node:events';
import { Transform } from 'node:stream';

class Probe extends Transform {
  constructor() { super(); }
}

const probe = new Probe();
probe.on('ping', function (this: EventEmitter, value: unknown) {
  console.log(value, this === probe);
});
console.log(probe instanceof Transform, probe instanceof EventEmitter);
console.log(probe.emit('ping', 9));
