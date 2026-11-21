import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost'}, () => console.log('unexpected secure'));
socket.on('connect', () => console.log('connect'));
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
socket.on('close', (hadError: boolean) => console.log('close', hadError));
