function convert(value) {
  return new Uint8Array(value)
}

console.log(Buffer.from(convert(new Uint8Array([1, 2, 255]))).toString('hex'))
console.log(Buffer.from(convert(Buffer.from([3, 4, 5]))).toString('hex'))
console.log(Buffer.from(convert([257, -1, 3.9])).toString('hex'))
console.log(convert(3).length)
console.log(convert(undefined).length)
const union = process.argv.length > 100 ? new Uint8Array([6]) : [7, 8]
console.log(Buffer.from(new Uint8Array(union)).toString('hex'))
