const { types } = require('node:util')
const direct = require('node:util/types')

const buffer = new ArrayBuffer(4)
const view = new Uint8Array(4)
const promise = Promise.resolve(1)
const proxy = new Proxy({}, {})
const ordinary = {}

function hasArrayBufferBacking(value) {
  return types.isArrayBuffer(value.buffer)
}

console.log(types.isArrayBuffer(buffer), direct.isAnyArrayBuffer(buffer))
console.log(types.isTypedArray(view), direct.isArrayBufferView(view))
console.log(types.isPromise(promise), direct.isPromise(ordinary))
console.log(types.isProxy(proxy), direct.isProxy(ordinary))
console.log(types.isSharedArrayBuffer(ordinary), direct.isDataView(ordinary))
console.log(hasArrayBufferBacking(view), hasArrayBufferBacking(ordinary))
console.log(ArrayBuffer.isView(view), ArrayBuffer.isView(buffer), ArrayBuffer.isView(ordinary))

const owner = new Uint8Array(4)
owner[0] = 10
owner[1] = 20
owner[2] = 30
owner[3] = 40
const window = new Uint8Array(owner.buffer, 1, 2)
console.log(window.length, window.byteOffset, window[0], window[1])
window[0] = 99
console.log(owner[1])
const tail = new Uint8Array(owner.buffer, 2)
console.log(tail.length, tail[0], tail[1])
const data = new DataView(owner.buffer, 1, 2)
console.log(direct.isDataView(data), data.byteOffset, data.byteLength, types.isArrayBuffer(data.buffer))
