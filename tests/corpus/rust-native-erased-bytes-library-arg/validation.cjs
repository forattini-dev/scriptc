'use strict'

const { isUtf8 } = require('buffer')

function _isValidUTF8 (buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) return false
  }
  return true
}

module.exports = { isValidUTF8: _isValidUTF8 }

if (isUtf8) {
  module.exports.isValidUTF8 = function (buf) {
    return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf)
  }
}
