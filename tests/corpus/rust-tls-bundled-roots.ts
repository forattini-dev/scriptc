// @no-engine
import { createHash } from "node:crypto";
import { getCACertificates, rootCertificates, setDefaultCACertificates } from "node:tls";

const roots = getCACertificates("bundled");
console.log(roots.length, rootCertificates === roots, getCACertificates("bundled") === roots);
console.log(createHash("sha256").update(roots.join("\n") + "\n").digest("hex"));
console.log(getCACertificates("default").length === roots.length);
setDefaultCACertificates([]);
console.log(getCACertificates("default").length, getCACertificates("bundled") === roots);
setDefaultCACertificates(roots);
console.log(getCACertificates("default").length === roots.length);
