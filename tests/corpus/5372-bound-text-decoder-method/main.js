'use strict'

const decoder = new TextDecoder('utf-8', { fatal: true })
const decode = decoder.decode.bind(decoder)
console.log(decode(Buffer.from('native')))
