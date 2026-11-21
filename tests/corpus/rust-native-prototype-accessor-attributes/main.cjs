'use strict'
const { Event, CloseEvent } = require('./event-target.cjs')

const open = new Event('open')
console.log(open.type, open.target)
const close = new CloseEvent('close', { code: 1000 })
console.log(close.type, close.code, close.target)
console.log(new CloseEvent('close').code)
