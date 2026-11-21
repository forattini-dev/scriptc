import * as tls from 'node:tls';
const port = Number(process.env.SCRIPTC_TLS_PORT);
const socket = tls.connect({host:'127.0.0.1', port, servername:'localhost', rejectUnauthorized:false}, () => {
  const cert = socket.getPeerCertificate();
  console.log('subject', Array.isArray(cert.subject?.CN), Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN, Array.isArray(cert.subject?.CN) ? cert.subject.CN[1] : '', Array.isArray(cert.subject?.O) ? cert.subject.O[0] : cert.subject?.O, Array.isArray(cert.subject?.O) ? cert.subject.O[1] : '');
  console.log('issuer', Array.isArray(cert.issuer?.CN), Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN, Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[1] : '', Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O, Array.isArray(cert.issuer?.O) ? cert.issuer.O[1] : '');
  socket.destroy();
});
socket.on('error', (error: NodeJS.ErrnoException) => console.log('error', error.code));
