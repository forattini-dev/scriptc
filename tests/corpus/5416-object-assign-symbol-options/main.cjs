const kOptions = Symbol('options')

class Factory {
  /** @type {typeof options} */
  [kOptions]

  /** @param {typeof options} input */
  constructor(input) {
    this[kOptions] = input
  }

  create() {
    const merged = Object.assign({ agent: this }, this[kOptions])
    return consume(merged, this)
  }
}

/**
 * @param {{ agent: any, connections?: number }} value
 * @param {any} owner
 */
function consume(value, owner) {
  return [value.agent === owner, value.connections, typeof value]
}

function options() {}
options.connections = 1

const result = new Factory(options).create()
console.log(result.join(','))
