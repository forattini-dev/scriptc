/// <reference types="node" />
import { createConnection, createServer } from 'node:net';
import { unlinkSync } from 'node:fs';

const path = process.platform === 'win32'
  ? `\\\\.\\pipe\\scriptc-server-callback-${process.pid}`
  : `/tmp/scriptc-server-callback-${process.pid}.sock`;

const server = createServer((socket) => {
  console.log('connected');
  socket.destroy();
  server.close();
});
server.listen(path, () => {
  const client = createConnection(path);
  client.on('error', () => {});
});
server.on('close', () => {
  if (process.platform !== 'win32') unlinkSync(path);
  console.log('closed');
  process.exit(0);
});
