'use strict'

const target = new EventTarget()
function late() { console.log('late') }
function added() { console.log('added') }
target.addEventListener('change', () => {
  console.log('first')
  target.removeEventListener('change', late)
  target.addEventListener('change', added)
}, { once: true })
target.addEventListener('change', late)
target.dispatchEvent(new Event('change'))
target.dispatchEvent(new Event('change'))

target.addEventListener('reenter', () => {
  console.log('once before recursive dispatch')
  target.dispatchEvent(new Event('reenter'))
}, { once: true })
target.dispatchEvent(new Event('reenter'))

const objectListener = { handleEvent(event) { console.log('object', this === objectListener, event.type) } }
target.addEventListener('object', objectListener)
target.dispatchEvent(new Event('object'))

target.addEventListener('passive', event => event.preventDefault(), { passive: true })
console.log('passive', target.dispatchEvent(new Event('passive', { cancelable: true })))
target.addEventListener('stop', event => { console.log('stop'); event.stopImmediatePropagation() })
target.addEventListener('stop', () => console.log('not reached'))
target.dispatchEvent(new Event('stop'))
target.addEventListener('phase', event => console.log('phase first', event.eventPhase, event.currentTarget === target))
target.addEventListener('phase', event => console.log('phase second', event.eventPhase, event.currentTarget === target))
target.dispatchEvent(new Event('phase'))

const controller = new AbortController()
function abortable() { console.log('abortable') }
target.addEventListener('abortable', abortable, { signal: controller.signal })
target.dispatchEvent(new Event('abortable'))
target.removeEventListener('abortable', abortable)
target.addEventListener('abortable', abortable)
controller.abort()
target.dispatchEvent(new Event('abortable'))
target.addEventListener('already-aborted', () => console.log('not reached'), { signal: controller.signal })
target.dispatchEvent(new Event('already-aborted'))
const firstSignal = new AbortController()
const secondSignal = new AbortController()
function duplicateSignal() { console.log('not reached') }
target.addEventListener('duplicate-signal', duplicateSignal, { signal: firstSignal.signal })
target.addEventListener('duplicate-signal', duplicateSignal, { signal: secondSignal.signal })
secondSignal.abort()
target.dispatchEvent(new Event('duplicate-signal'))
console.log('signals done')
