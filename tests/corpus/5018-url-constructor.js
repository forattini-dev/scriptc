// @ts-nocheck
const value = new URL("../graphql?x=1#hash", "https://github.test/api/v3/");
console.log(value.pathname === "/api/graphql");
console.log(value.search === "?x=1");
console.log(value.hash === "#hash");
console.log(value === value);
