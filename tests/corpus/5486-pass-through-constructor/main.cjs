const { PassThrough } = require('node:stream')

const stream = new PassThrough()
console.log(stream.destroy() === stream)
console.log(stream instanceof PassThrough)
