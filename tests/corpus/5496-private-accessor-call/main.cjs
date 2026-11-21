'use strict'

class Handler {
  get #callback() {
    console.log('getter')
    return function (value) { console.log(this === handler, value) }
  }

  run() {
    let reads = 0
    const receiver = () => { reads++; return this }
    const argument = () => { console.log('argument evaluated'); return 'argument' }
    receiver().#callback(...[argument()])
    console.log('receiver evaluations', reads)
  }
}

const handler = new Handler()
handler.run()
