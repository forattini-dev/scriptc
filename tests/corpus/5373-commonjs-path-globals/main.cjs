'use strict'

console.log(
  typeof __filename,
  __filename.endsWith('main.cjs'),
  typeof __dirname,
  __filename.startsWith(__dirname)
)
