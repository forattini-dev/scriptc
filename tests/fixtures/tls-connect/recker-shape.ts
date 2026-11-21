import * as tls from 'node:tls';
function probe(host: string, port: number): Promise<{host:string, valid:boolean, protocol:string|null, cipher:string|undefined, subject:string|undefined, issuer:string|undefined, validFrom:string, validTo:string, fingerprint:string}> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host, port, servername:'localhost', rejectUnauthorized:false}, () => {
      const cert = socket.getPeerCertificate();
      const protocol = socket.getProtocol();
      const cipher = socket.getCipher();
      socket.end();
      resolve({host, valid:socket.authorized, protocol, cipher:cipher?.name, subject:Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN, issuer:Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O, validFrom:cert.valid_from, validTo:cert.valid_to, fingerprint:cert.fingerprint});
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Connection timeout')); });
  });
}
void probe('127.0.0.1', Number(process.env.SCRIPTC_TLS_PORT)).then(result => console.log(JSON.stringify(result)));
