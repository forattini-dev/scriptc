const nonDefault = new URL("https://example.com:8443/path#frag");
const defaultPort = new URL("https://example.com:443/path#");
console.log(nonDefault.port, nonDefault.hash);
console.log(`<${defaultPort.port}>`, `<${defaultPort.hash}>`, defaultPort.href);
