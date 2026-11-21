// @rust-only
// @no-engine
/** @type {Symbol} */
const key = Symbol('fast')

class FastTimer {
  [key] = true
}

const timer = new FastTimer()
console.log(timer[key], key.description)
