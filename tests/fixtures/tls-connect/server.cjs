const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '../../fixtures/server/certs');
const certificate = process.env.SCRIPTC_TLS_REPEATED === '1' ? path.join(__dirname, 'repeated.pem') : path.join(base, 'localhost.pem');
const options = {key:fs.readFileSync(path.join(base, 'localhost-key.pem')), cert:fs.readFileSync(certificate)};
if (process.env.SCRIPTC_TLS_ONLY_12 === '1') {
  options.minVersion = 'TLSv1.2';
  options.maxVersion = 'TLSv1.2';
  options.ciphers = 'ECDHE-ECDSA-AES256-GCM-SHA384';
}
const server = tls.createServer(options, socket => {
  socket.on('data', data => {
    if (data.toString() === 'ping') socket.end('pong');
    if (data.toString() === 'timer') {
      setTimeout(() => socket.write('a'), 100);
      setTimeout(() => socket.write('b'), 200);
      setTimeout(() => socket.write('c'), 400);
    }
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
