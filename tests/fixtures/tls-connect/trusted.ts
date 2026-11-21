import * as tls from 'node:tls';
import { readFileSync } from 'node:fs';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const ca = readFileSync(process.env.SCRIPTC_TLS_CA!, 'utf8');
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', ca}, function (this: tls.TLSSocket) {
  console.log('verified', this === socket, socket.authorized);
  socket.write('ping');
});
socket.on('data', (chunk: Buffer) => { console.log('data', chunk.toString()); socket.end(); });
socket.on('close', (hadError: boolean) => console.log('close', hadError));
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
