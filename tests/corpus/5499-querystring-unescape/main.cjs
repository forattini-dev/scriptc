'use strict'
const querystring = require('node:querystring')
const { unescape: decode } = querystring

const inputs = [
  '', 'plain', 'a+b', '%20', '%2B', '%2b', '%25', '%00', '%41', '%7E',
  '%E2%98%83', '%F0%9F%98%80', 'é%20😀', '%E9', '%C3%28', '%FF', '%80',
  '%C0%AF', '%ED%A0%80', '%F0%9F', '%GG%41', '%', '%A', '%1G', '%G1',
  '☃%E9', '😀%E9', String.fromCharCode(0xD800) + '%41',
  String.fromCharCode(0xDC00) + '%41', '%00%2B', 'x%26y%3Dz',
  '%E2%82%AC%20ok', 'a%%41', 'x%20%ZZ', '%F4%90%80%80',
]
for (const value of inputs) console.log(JSON.stringify(decode(value)))
console.log(querystring.unescape('hello%20world'))
