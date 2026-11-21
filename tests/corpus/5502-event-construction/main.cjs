'use strict'
const empty = new Event('empty')
console.log(empty.type, empty.bubbles, empty.cancelable, empty.composed, empty.defaultPrevented)
console.log(empty.target === null, empty.currentTarget === null, empty.eventPhase, empty.isTrusted)
const full = new Event('full', { bubbles: true, cancelable: true, composed: true })
console.log(full.type, full.bubbles, full.cancelable, full.composed, full.defaultPrevented)
empty.preventDefault()
full.preventDefault()
full.stopPropagation()
console.log(empty.defaultPrevented, full.defaultPrevented, full.cancelBubble)
full.stopImmediatePropagation()
const absentOptions = new Event('null', null)
console.log(absentOptions.cancelable)
try {
  new Event('wrong', 1)
} catch (error) {
  console.log(error instanceof TypeError)
}
