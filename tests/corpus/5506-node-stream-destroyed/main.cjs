const { Duplex, Readable, Writable, Transform } = require('node:stream')

/** @param {Duplex | null | undefined} stream */
function state(stream) {
  return stream?.destroyed
}

const duplex = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback() } })
const alias = duplex
console.log(state(null), state(undefined))
console.log(state(duplex), duplex.destroyed, duplex._readableState.destroyed)
console.log(duplex.destroy() === alias)
console.log(state(alias), alias.destroyed, alias._readableState.destroyed)
console.log(alias.destroy() === duplex, state(duplex))

const readable = new Readable({ read() {} })
const writable = new Writable({ write(_chunk, _encoding, callback) { callback() } })
const transform = new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk) } })
console.log(readable.destroyed, writable.destroyed, transform.destroyed)
readable.destroy()
writable.destroy()
transform.destroy()
console.log(readable.destroyed, writable.destroyed, transform.destroyed)
