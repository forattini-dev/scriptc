// URL.port — the digit string, but "" whenever the port is ABSENT or equals
// the scheme's default (http/ws 80, https/wss 443, ftp 21). The parser drops
// defaults at parse time, so the getter is a verbatim field read; port 0 is a
// real, non-default port and survives.
const noPort = new URL("http://example.com/a");
const defaultHttp = new URL("http://example.com:80/a");
const explicitHttp = new URL("http://example.com:8080/a");
const defaultHttps = new URL("https://example.com:443/");
const explicitHttps = new URL("https://x.com:8443/p");
const defaultWs = new URL("ws://e.com:80/");
const defaultWss = new URL("wss://e.com:443/");
const defaultFtp = new URL("ftp://h.com:21/x");
const explicitFtp = new URL("ftp://h.com:2121/x");
const zeroPort = new URL("http://a.com:0/");
const leadingZeros = new URL("http://a.com:00080/");
const opaque = new URL("data:text/plain,hi");
const fileUrl = new URL("file:///tmp/x");
console.log(`<${noPort.port}>`);
console.log(`<${defaultHttp.port}>`);
console.log(`<${explicitHttp.port}>`);
console.log(`<${defaultHttps.port}>`);
console.log(`<${explicitHttps.port}>`);
console.log(`<${defaultWs.port}>`);
console.log(`<${defaultWss.port}>`);
console.log(`<${defaultFtp.port}>`);
console.log(`<${explicitFtp.port}>`);
console.log(`<${zeroPort.port}>`);
console.log(`<${leadingZeros.port}>`);
console.log(`<${opaque.port}>`);
console.log(`<${fileUrl.port}>`);
// The default port never survives into href or host either.
console.log(defaultHttp.href, defaultHttp.host);
console.log(explicitHttp.href, explicitHttp.host);
// port is the exact tail of host when present, and host === hostname when not.
console.log(explicitHttp.host === `${explicitHttp.hostname}:${explicitHttp.port}`);
console.log(noPort.host === noPort.hostname);
// Composes with unions.
const maybe: URL | undefined = explicitHttps;
console.log(maybe !== undefined ? maybe.port : "none");
