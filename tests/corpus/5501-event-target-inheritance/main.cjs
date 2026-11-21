'use strict'
class SocketTarget extends EventTarget {}
const target = new SocketTarget()
console.log(target instanceof SocketTarget, target instanceof EventTarget)
const direct = new EventTarget()
console.log(direct instanceof EventTarget, direct instanceof SocketTarget)
