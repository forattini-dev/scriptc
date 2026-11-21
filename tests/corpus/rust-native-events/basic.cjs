'use strict';
const EventEmitter = require('node:events');

class Bus extends EventEmitter {
  constructor() { super(); }
}

const bus = new Bus();
const persistent = function (value) { console.log('on', value, this === bus); };
bus.on('tick', persistent);
bus.once('tick', function (value) { console.log('once', value, this === bus); });
console.log(bus instanceof EventEmitter, bus.emit('tick', 1));
console.log(bus.emit('tick', 2));
bus.off('tick', persistent);
console.log(bus.emit('tick', 3));
