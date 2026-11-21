const { Transform } = require('node:stream');

const order = [];
const stream = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk);
  },
  marker: order.push('options')
});

console.log(order.join(','), stream instanceof Transform);
