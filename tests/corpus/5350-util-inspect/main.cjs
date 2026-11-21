const { inspect } = require('node:util')

console.log(inspect(42))
console.log(inspect('hello'))
console.log(typeof inspect({ answer: 42 }))
