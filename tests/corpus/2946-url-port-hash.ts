const cases = [
  "https://example.com:443/path#",
  "https://example.com:8443/path#frag",
  "http://example.com:00080/path",
  "http://example.com:00081/a#x y",
  "ws://example.com:80/path#x",
  "wss://example.com:443/path#",
  "ftp://example.com:21/file#f",
  "file:///tmp/a#",
  "data:text/plain,hi#a#b",
  "foo://host:00042/p#%41",
  "https://[::1]:8080/a#é",
];
for (const source of cases) {
  const url = new URL(source);
  console.log(`<${url.port}>`, `<${url.hash}>`, url.host, url.href);
}

const live = new URL("https://host.test:8443/path?q=1#frag");
live.searchParams.set("q", "2");
console.log(live.port, live.hash, live.search, live.href);
