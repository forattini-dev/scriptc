'use strict'
for (const size of [0, 1, 4, 32, 4096]) {
  const buffer = Buffer.allocUnsafeSlow(size)
  if (size > 0) {
    buffer[0] = 17
    buffer[size - 1] = 42
  }
  console.log(Buffer.isBuffer(buffer), buffer.length, size > 0 ? buffer[0] : 0, size > 0 ? buffer[size - 1] : 0)
}
try { Buffer.allocUnsafeSlow(-1) } catch (error) { console.log(error instanceof RangeError) }
