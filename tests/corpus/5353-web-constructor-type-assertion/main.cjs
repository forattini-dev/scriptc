const callHasInstance = Function.call.bind(Function.prototype[Symbol.hasInstance])

function makeTypeAssertion(I) {
  return (O) => callHasInstance(I, O)
}

class Marker {}
console.log(new Marker() instanceof Marker)

const isReadableStream = makeTypeAssertion(ReadableStream)
const isBlob = makeTypeAssertion(Blob)
const isURLSearchParams = makeTypeAssertion(URLSearchParams)
const isFile = makeTypeAssertion(File)
const isURL = makeTypeAssertion(URL)
const isAbortSignal = makeTypeAssertion(AbortSignal)
const isMessagePort = makeTypeAssertion(MessagePort)

const ordinary = {}
console.log([
  isReadableStream(ordinary),
  isBlob(ordinary),
  isURLSearchParams(ordinary),
  isFile(ordinary),
  isURL(ordinary),
  isAbortSignal(ordinary),
  isMessagePort(ordinary)
].join(','))

console.log(isURLSearchParams(new URLSearchParams('a=1')))
console.log(isURL(new URL('https://example.com/path')))
console.log(isAbortSignal(AbortSignal.abort()))
