const EventEmitter = require('node:events');

const emitter = new EventEmitter();
const seen = [];
const returned = EventEmitter.prototype.on.call(emitter, 'value', function (value) {
  seen.push(value);
});

emitter.emit('value', 'native');
console.log(returned === emitter, seen.join(','));
