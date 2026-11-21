'use strict'

const buffer = Buffer.alloc(12)
console.log(buffer.write('ab'), buffer.toString('hex'))
console.log(buffer.write('é💩z', 2, 5, 'utf-8'), buffer.toString('hex'))
console.log(buffer.write('é💩z', 2, 6, 'utf8'), buffer.toString('hex'))
console.log(buffer.write('414243', 'hex'), buffer.toString('hex'))
console.log(buffer.write('ZXY', 9, 'ascii'), buffer.toString('hex'))
console.log(buffer.write('ab', 1, 3, 'utf16le'), buffer.toString('hex'))
console.log(buffer.write('YWJjZA==', 4, 2, 'base64'), buffer.toString('hex'))
const view = buffer.subarray(3, 8)
console.log(view.write('q', 1), buffer.toString('hex'))
console.log(buffer.write('ignored', undefined, 0, 'bad'), buffer.toString('hex'))
for (const offset of [-1, 0.5, 13, NaN]) {
  try { buffer.write('x', offset) } catch (error) { console.log(error.name, error.code) }
}
try { buffer.write('x', 0, 13) } catch (error) { console.log(error.name, error.code) }
try { buffer.write('x', 0, 0, 'bad') } catch (error) { console.log(error.name, error.code) }
try { buffer.write('x', null) } catch (error) { console.log(error.name, error.code) }
try { buffer.write(42) } catch (error) { console.log(error.name, error.code) }
try { buffer.write(42, -1) } catch (error) { console.log(error.name, error.code) }
try { buffer.write(42, 0, 'bad') } catch (error) { console.log(error.name, error.code) }
const array = new Uint8Array(2)
try { array.write('x') } catch (error) { console.log(error instanceof TypeError) }
