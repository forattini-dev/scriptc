'use strict'

/** @type {NodeJS.Timeout | undefined} */
let timer
console.log('missing', timer?.refresh === undefined)
timer = setTimeout(() => console.log('unexpected'), 10000)
const refresh = timer?.refresh
const same = timer?.refresh
const unref = timer?.unref
console.log('properties', typeof refresh, refresh === same, refresh !== unref)
const other = setTimeout(() => console.log('unexpected'), 10000)
console.log('shared prototype', refresh === other?.refresh)
clearTimeout(other)
if (timer?.refresh) {
  console.log('refresh', timer.refresh() === timer)
}
timer?.unref()
console.log('unref', timer.hasRef())
timer.ref()
console.log('ref', timer.hasRef())
try { refresh() } catch (error) { console.log('unbound', error instanceof TypeError) }
clearTimeout(timer)
