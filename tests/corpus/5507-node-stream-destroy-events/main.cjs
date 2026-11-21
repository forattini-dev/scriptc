'use strict'

const { PassThrough } = require('node:stream')

const stream = new PassThrough()
const error = new Error('broken')
stream.on('error', function (value) {
  console.log('error', value === error, this === stream, stream.destroyed)
})
stream.once('close', function () {
  console.log('close', this === stream, stream.destroyed)
})
console.log('before', stream.destroyed)
console.log('return', stream.destroy(error) === stream, stream.destroyed)
stream.destroy(new Error('ignored'))

const clean = new PassThrough()
clean.destroy(null)
clean.on('close', () => console.log('clean close', clean.destroyed))
console.log('after')
