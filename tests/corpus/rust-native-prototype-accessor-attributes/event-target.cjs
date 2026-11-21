'use strict'

const kTarget = Symbol('kTarget')
const kType = Symbol('kType')
const kCode = Symbol('kCode')

class Event {
  constructor (type) {
    this[kTarget] = null
    this[kType] = type
  }

  get target () {
    return this[kTarget]
  }

  get type () {
    return this[kType]
  }
}

Object.defineProperty(Event.prototype, 'target', { enumerable: true })
Object.defineProperty(Event.prototype, 'type', { enumerable: true })

class CloseEvent extends Event {
  constructor (type, options = {}) {
    super(type)
    this[kCode] = options.code === undefined ? 0 : options.code
  }

  get code () {
    return this[kCode]
  }
}

Object.defineProperty(CloseEvent.prototype, 'code', { enumerable: true })

;['type', 'target'].forEach((property) => {
  Object.defineProperty(Event.prototype, property, { enumerable: true })
})

module.exports = { Event, CloseEvent }
