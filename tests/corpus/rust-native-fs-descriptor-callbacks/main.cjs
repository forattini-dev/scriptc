'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = path.join(os.tmpdir(), 'scriptc-fs-callbacks-' + process.pid)
const file = path.join(dir, 'nested', 'log.txt')

fs.mkdir(path.dirname(file), { recursive: true }, (mkdirError) => {
  console.log('mkdir', mkdirError)
  fs.open(file, 'a', 0o666, (openError, fd) => {
    console.log('open', openError, typeof fd)
    fs.write(fd, 'first line\n', (writeError, written) => {
      console.log('write string', writeError, written)
      fs.write(fd, Buffer.from('second\n'), (bufferError, bytes) => {
        console.log('write buffer', bufferError, bytes)
        console.log('writeSync', fs.writeSync(fd, 'third\n', 'utf8'))
        fs.fsyncSync(fd)
        fs.fsync(fd, (syncError) => {
          console.log('fsync', syncError)
          fs.close(fd, (closeError) => {
            console.log('close', closeError)
            console.log(JSON.stringify(fs.readFileSync(file, 'utf8')))
            fs.close(fd, (again) => {
              console.log('close again', again && again.code)
              fs.rmSync(dir, { recursive: true, force: true })
            })
          })
        })
      })
    })
  })
})
console.log('scheduled')
