import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false});
socket.once('secureConnect', function (this: tls.TLSSocket) { console.log('secure', this === socket, socket.authorized); socket.write('ping'); });
socket.once('data', (chunk: Buffer) => { console.log('data', chunk.toString()); socket.end(); });
socket.on('close', (hadError: boolean) => console.log('close', hadError));
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
