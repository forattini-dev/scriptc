// @dynamic
// Request values use the embedded realm's actual constructor identity.
const request = new Request("https://example.test/path");
console.log(request instanceof Request);
console.log(new Request(request) instanceof Request);
console.log({} instanceof Request);
