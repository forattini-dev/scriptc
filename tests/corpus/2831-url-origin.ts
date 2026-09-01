// URL.origin — the WHATWG tuple origin "scheme://host[:non-default-port]"
// for the special schemes that HAVE one (http/https/ws/wss/ftp), and the
// literal string "null" for file: and every opaque-path scheme. Userinfo is
// never part of an origin, and the default port is already stripped.
const plain = new URL("http://example.com/a/b?q=1#f");
const defaultPort = new URL("http://example.com:80/a");
const explicitPort = new URL("http://example.com:8080/a");
const secure = new URL("https://example.com:443/");
const securePort = new URL("https://x.com:8443/p?q=1#frag");
const withUser = new URL("http://user:pw@example.com:99/p");
const ws = new URL("ws://e.com:80/");
const wss = new URL("wss://e.com:9443/");
const ftp = new URL("ftp://h.com:21/x");
const upperHost = new URL("HTTP://Example.COM/x");
const fileUrl = new URL("file:///tmp/a.txt");
const fileHost = new URL("file://h.example/p");
const mail = new URL("mailto:x@y.com");
const data = new URL("data:text/plain,hi");
const git = new URL("git://h.com:9/x");
console.log(plain.origin);
console.log(defaultPort.origin);
console.log(explicitPort.origin);
console.log(secure.origin);
console.log(securePort.origin);
console.log(withUser.origin);
console.log(ws.origin);
console.log(wss.origin);
console.log(ftp.origin);
console.log(upperHost.origin);
console.log(fileUrl.origin);
console.log(fileHost.origin);
console.log(mail.origin);
console.log(data.origin);
console.log(git.origin);
// origin is protocol + "//" + host for the tuple-origin schemes.
console.log(plain.origin === `${plain.protocol}//${plain.host}`);
console.log(explicitPort.origin === `${explicitPort.protocol}//${explicitPort.host}`);
// The opaque schemes answer the four-character string "null", not a null value.
console.log(fileUrl.origin === "null", fileUrl.origin.length);
// Two URLs differing only in path share an origin.
console.log(plain.origin === new URL("http://example.com/other").origin);
