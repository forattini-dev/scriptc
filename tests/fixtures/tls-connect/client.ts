import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
console.log('start');
const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false }, function (this: tls.TLSSocket) {
  console.log('secure callback', this === socket, socket.authorized, socket.encrypted);
  socket.write('ping');
});
socket.on('connect', function (this: tls.TLSSocket) { console.log('connect', this === socket); });
socket.on('secureConnect', function (this: tls.TLSSocket) { console.log('secure event', this === socket); });
socket.on('data', function (chunk: Buffer) { console.log('data', chunk.toString()); socket.end(); });
socket.on('end', function () { console.log('end'); });
socket.on('close', function (hadError: boolean) { console.log('close', hadError); });
socket.on('error', function (error: NodeJS.ErrnoException) { console.log('error', error.code); });
console.log('scheduled');
