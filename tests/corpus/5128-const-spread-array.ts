const EXTRA = { SSL_CERT_FILE: "cert", NODE_EXTRA_CA_CERTS: "extra" } as const;
const ENVIRONMENT = [
  "PATH",
  "PUPPETEER_CACHE_DIR",
  ...Object.keys(EXTRA),
] as const;

console.log(ENVIRONMENT.length);
console.log(ENVIRONMENT.join(","));
console.log(ENVIRONMENT[3]);
