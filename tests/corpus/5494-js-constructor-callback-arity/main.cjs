'use strict'

class RevalidationHandler {
  /** @type {((boolean, any) => void) | null} */
  #callback

  /** @param {(boolean) => void} callback */
  constructor(callback) {
    this.#callback = callback
  }

  run(context) {
    this.#callback(true, context)
    this.#callback = null
  }

  runSpread(context) {
    let reads = 0
    const receiver = () => { reads++; return this }
    receiver().#callback(...[true, context])
    console.log('receiver evaluations', reads)
  }
}

const handler = new RevalidationHandler((success, context) => {
  console.log(success, context)
})
handler.run('preserved')

const other = new RevalidationHandler(function (success, context) {
  console.log(this === other, success, context)
})
other.run('receiver')
const spread = new RevalidationHandler((success, context) => console.log(success, context))
spread.runSpread('spread')
