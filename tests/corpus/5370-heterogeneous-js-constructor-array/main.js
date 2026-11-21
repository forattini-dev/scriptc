'use strict'

function LocalHeaders () {}

const constructors = [LocalHeaders, globalThis.Headers].filter(Boolean)
console.log(constructors.length > 0)
