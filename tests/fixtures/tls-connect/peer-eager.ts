// @ts-nocheck
import * as tls from 'node:tls';
function start() {
  const socket = tls.connect({host: socket.remoteAddress, port: 1, servername: 'localhost'}, () => console.log(socket.authorized));
}
start();
