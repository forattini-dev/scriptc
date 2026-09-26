const urls = [
  "https://user:pass@Example.COM:443/a",
  "http://us%3Aer:p@host.test:8080/x",
  "ftp://name@host.test:21/x",
  "ws://host.test:8080/x",
  "file:///tmp/a",
  "data:text/plain,hello",
  "custom://user@host.test/a",
  "blob:https://Example.COM:443/id",
  "blob:ftp://host.test/id",
  "blob:null/id",
];
for (const raw of urls) {
  const url = new URL(raw);
  console.log(url.origin, url.username);
}
