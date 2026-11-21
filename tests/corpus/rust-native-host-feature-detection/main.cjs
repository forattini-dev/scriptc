'use strict'
const sleep = require('./sleep.cjs')
const started = Date.now()
sleep(30)
console.log(Date.now() - started >= 25)
for (const bad of [0, -1, Infinity, 'x']) {
  try { sleep(bad) } catch (error) { console.log(error.name, error.message) }
}
