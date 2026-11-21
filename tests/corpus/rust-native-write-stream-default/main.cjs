'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-ws-'))
const target = path.join(dir, 'download.txt')
const stream = fs.createWriteStream(target)
stream.write('line one\n')
stream.write('line two\n')
stream.end(() => {
  console.log(JSON.stringify(fs.readFileSync(target, 'utf8')))
  const second = path.join(dir, 'encoded.txt')
  const encoded = fs.createWriteStream(second, 'utf8')
  encoded.end('done', () => {
    console.log(fs.readFileSync(second, 'utf8'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
