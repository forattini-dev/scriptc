import { isDestroyed, isDisturbed, isErrored, isReadable } from 'node:stream'

const value = {}
console.log(
  isDisturbed(value),
  isErrored(value),
  isReadable(value),
  isDestroyed(value)
)
