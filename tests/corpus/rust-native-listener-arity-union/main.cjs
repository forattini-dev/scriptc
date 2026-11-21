'use strict'
const { EventEmitter } = require('events')

function addEventListener (target, type, handler) {
  let wrapper
  if (type === 'message') {
    wrapper = function onMessage (data, isBinary) {
      handler({ type, data: isBinary ? '<binary>' : String(data) })
    }
  } else if (type === 'close') {
    wrapper = function onClose (code) {
      handler({ type, code })
    }
  } else if (type === 'open') {
    wrapper = function onOpen () {
      handler({ type })
    }
  } else {
    return
  }
  target.on(type, wrapper)
}

const socket = new EventEmitter()
const seen = []
for (const type of ['message', 'close', 'open', 'error']) {
  addEventListener(socket, type, (event) => seen.push(JSON.stringify(event)))
}
socket.emit('open')
socket.emit('message', 'hello', false)
socket.emit('message', 'raw', true)
socket.emit('close', 1000)
console.log(seen.join('\n'))

class Hub extends EventEmitter {
  constructor () {
    super()
    this.relay = null
    const emitConnection = this.emit.bind(this, 'connection')
    this.relay = (client) => emitConnection(client, 'via-relay')
  }
}
const hub = new Hub()
hub.on('connection', (client, how) => console.log('connection', client, how))
hub.relay('ada')

function handleUpgrade (req, socket, cb) {
  cb(req, socket)
}
const forward = hub.emit.bind(hub, 'connection')
handleUpgrade('upgrade-req', 'tcp', forward)
