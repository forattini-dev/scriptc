const { Console } = require('node:console');

const order = [];
const logger = new Console({
  stdout: process.stdout,
  inspectOptions: { colors: false },
  marker: order.push('options')
});

console.log(order.join(','), logger instanceof Console);
