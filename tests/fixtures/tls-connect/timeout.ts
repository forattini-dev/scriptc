import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
let received = '';
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false}, () => {
  socket.setTimeout(350);
  socket.write('timer');
});
socket.on('data', (chunk: Buffer) => { received += chunk.toString(); });
socket.on('timeout', () => { console.log('timeout', received, socket.destroyed); socket.destroy(); });
socket.on('close', (hadError: boolean) => console.log('close', hadError));
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
