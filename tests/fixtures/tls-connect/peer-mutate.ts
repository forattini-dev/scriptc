import * as tls from 'node:tls';
const socket = tls.connect({host:'127.0.0.1', port:443, servername:'localhost'}, () => {
  const cert = socket.getPeerCertificate();
  cert.valid_from = 'changed';
});
