const { Duplex, Readable } = require('node:stream')

const stream = new Duplex({
  readableObjectMode: true,
  read() {},
  write(_chunk, _encoding, callback) { callback() }
})
console.log(stream instanceof Duplex)
console.log(stream instanceof Readable)
console.log(stream.on('error', () => {}) === stream)
console.log(stream.pause() === stream)
console.log(stream.resume() === stream)
console.log(stream._readableState.destroyed)
console.log(stream._readableState.endEmitted)
console.log(stream._readableState.ended)
console.log(stream._readableState.encoding === null)
console.log(stream.write('x'))
console.log(stream.push('y'))
console.log(stream.isPaused())
stream.cork()
console.log('corked')
stream.uncork()
console.log('uncorked')
console.log(stream.end() === stream)
console.log(stream.destroy() === stream)
