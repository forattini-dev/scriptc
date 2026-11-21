const {
  types: {
    isPromise
  }
} = require('node:util')

console.log(isPromise(Promise.resolve(1)), isPromise({ then () {} }))
