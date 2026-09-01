const url = new URL("file:///tmp/rsp.bundle.min.mjs");
url.pathname = url.pathname.replace(
  /\/rsp\.bundle\.min\.mjs$/,
  "/rsp-core.bundle.min.mjs",
);
console.log(url.href);

url.pathname = "/a b/../c";
console.log(url.pathname, url.href);
