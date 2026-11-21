'use strict'

const util = require('node:util')
const direct = util.debuglog('scriptc-disabled-fixture')
const { debuglog } = require('node:util')
const destructured = debuglog('scriptc-disabled-fixture-two')

console.log(typeof direct, direct.enabled)
console.log(typeof destructured, destructured.enabled)
direct('this output is disabled', 1)
destructured('this output is disabled', 2)
