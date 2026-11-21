'use strict'
let fired = 0
const timer = setTimeout(() => { fired += 1 }, 5)
// check whether unref is available as it differs from browser to NodeJS (#33)
if (timer.unref && typeof timer.unref === 'function') {
  timer.unref()
  console.log('unref available')
}
const keep = setTimeout(() => console.log('keep fired', fired), 30)
console.log(!timer.unref ? 'missing' : 'present', typeof keep.ref)
