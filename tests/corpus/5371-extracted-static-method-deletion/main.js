'use strict'

class MessageEvent {
  static createFastMessageEvent (value) {
    return `fast:${value}`
  }
}

const { createFastMessageEvent } = MessageEvent
console.log(delete MessageEvent.createFastMessageEvent, createFastMessageEvent('ok'))
