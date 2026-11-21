'use strict'
const http = require('http')

const server = http.createServer((req, res) => {
  res.setHeader('x-path', req.url)
  if (req.url === '/missing') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'x-method': req.method })
  res.write('hello ')
  res.end(`${req.headers['x-test'] || '-'} ${req.httpVersion}`)
})

server.listen(0, '127.0.0.1', async () => {
  const { port, family, address } = server.address()
  console.log('listening', typeof port, port > 0, family, address)
  const ok = await fetch(`http://127.0.0.1:${port}/hello`, { headers: { 'x-test': 'yes' } })
  console.log(ok.status, ok.headers.get('x-path'), ok.headers.get('x-method'), ok.headers.get('content-type'), JSON.stringify(await ok.text()))
  const missing = await fetch(`http://127.0.0.1:${port}/missing`)
  console.log(missing.status, await missing.text())
  server.close(() => console.log('closed'))
})
