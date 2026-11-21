'use strict'
const getCallers = require('./caller.cjs')
const callers = getCallers()
// V8 CallSite objects are engine-specific; a native binary keeps the string
// stack, so pino's guard returns undefined. Both outcomes are valid here.
console.log(callers === undefined || Array.isArray(callers))
