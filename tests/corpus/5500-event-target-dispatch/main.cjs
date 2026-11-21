'use strict'

class Target extends EventTarget {}
const target = new Target()
let calls = 0
function listener(event) {
  calls++
  console.log('listener', this === target, event.target === target, event.type)
  event.preventDefault()
}
target.addEventListener('message', listener)
target.addEventListener('message', listener)
target.addEventListener('message', () => console.log('once'), { once: true })
console.log('first', target.dispatchEvent(new Event('message', { cancelable: true })), calls)
console.log('second', target.dispatchEvent(new Event('message')), calls)
target.removeEventListener('message', listener)
console.log('removed', target.dispatchEvent(new Event('message')), calls)
