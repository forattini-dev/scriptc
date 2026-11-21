// @rust-only
// @no-engine
/** @type {number|undefined} */
let handle

const owner = {
  start() { handle = 7 },
  reset() { handle = null }
}

owner.start()
console.log(handle)
owner.reset()
console.log(handle)
