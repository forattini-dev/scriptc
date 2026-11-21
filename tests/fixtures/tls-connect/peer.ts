import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false}, () => {
  const cert = socket.getPeerCertificate();
  const subject = Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN;
  const issuer = Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O;
  const issuerCN = Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN;
  console.log('names', subject, issuerCN, issuer);
  console.log('validity', cert.valid_from, cert.valid_to);
  console.log('fingerprints', cert.fingerprint, cert.fingerprint256, cert.fingerprint512);
  console.log('serial', cert.serialNumber, cert.ca);
  socket.destroy();
});
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
