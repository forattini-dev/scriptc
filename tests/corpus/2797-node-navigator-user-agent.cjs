const userAgent = navigator.userAgent;
const compatibilityMajor = process.versions.node.split(".")[0];

console.log(typeof navigator);
console.log("userAgent" in navigator);
console.log(userAgent === `Node.js/${compatibilityMajor}`);
