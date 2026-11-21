import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false}, () => {
  const cipher = socket.getCipher();
  console.log('secure', socket.getProtocol(), cipher.name, cipher.standardName, cipher.version);
  socket.destroy();
});
console.log('before', socket.getProtocol(), typeof socket.getCipher());
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
socket.on('close', () => console.log('closed', socket.getProtocol(), socket.getCipher() === null));
