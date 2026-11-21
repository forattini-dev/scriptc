const nodeUtil = require('node:util')

console.log(nodeUtil.formatWithOptions({}, 'ready'))
console.log(nodeUtil.formatWithOptions({}, 42))
console.log(nodeUtil.formatWithOptions({}, { __proto__: null, answer: 42 }))
