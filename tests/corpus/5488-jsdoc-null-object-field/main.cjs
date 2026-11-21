const { Duplex } = require('node:stream')

function run() {
  /** @type {{ socket: import('node:stream').Duplex }} */
  const handler = { socket: null }

  console.log(handler.socket === null)
  handler.socket = new Duplex()
  console.log(handler.socket.pause() === handler.socket)
}

run()
