const { make } = require('./maker.cjs')

/** @type {*} */
const value = make()
console.log(value.origin, value.count)
