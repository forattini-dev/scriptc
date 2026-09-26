// A factory-returned CommonJS root is evaluated once, cached by identity,
// and remains the object later `module.exports.member =` statements mutate.
const api = require("./factory.cjs");
const again = require("./factory.cjs");

console.log(api === again, api.prefix, api.count, api.extra);
