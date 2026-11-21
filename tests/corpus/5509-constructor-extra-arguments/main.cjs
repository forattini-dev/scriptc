'use strict'

let state = 0
function next(label) {
  state++
  console.log(label, state)
  return state
}
function fail() {
  console.log('extra throws')
  throw new Error('extra')
}

class Base extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'Base'
  }
}
class Invalid extends Base {
  constructor(message) {
    super(message)
    console.log('constructor', message, state)
  }
}

const first = new Invalid(next('first'), { cause: next('second') }, next('third'))
console.log(first.name, first.message, 'cause' in first)
try {
  new Invalid(next('accepted'), fail())
} catch (error) {
  console.log('caught', error.message, state)
}

class Empty {
  constructor() { console.log('empty', state) }
}
new Empty(next('ignored'))

class Observes {
  constructor(...items) { console.log('rest', items.length, items[1]) }
}
new Observes(1, 2, 3)

class ObservesArguments {
  constructor() { console.log('arguments', arguments.length, arguments[1]) }
}
new ObservesArguments(4, 5, 6)
