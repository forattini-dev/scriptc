'use strict'
process.on('uncaughtException', error => console.log('caught', error.message))
const target = new EventTarget()
target.addEventListener('x', () => { console.log('first'); throw new Error('sync') })
target.addEventListener('x', async () => { console.log('async'); throw new Error('async') })
target.addEventListener('x', () => console.log('last'))
console.log('result', target.dispatchEvent(new Event('x')))
console.log('after')
