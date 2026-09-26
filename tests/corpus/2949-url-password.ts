const urls = [
  "https://user:pass@Example.COM/a",
  "https://us%3Aer:p%3Ass@host.test/",
  "https://user:@host.test/",
  "https://host.test/",
  "ftp://name:pa%20ss@host.test/",
  "custom://:secret@host.test/",
  "file:///tmp/a",
  "data:text/plain,a",
];
for (const raw of urls) {
  const url = new URL(raw);
  console.log(JSON.stringify([url.username, url.password, url.href]));
}
