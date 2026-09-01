// URL.username / URL.password — the percent-ENCODED userinfo components,
// split at the first ':'. Both answer "" when absent, and password answers ""
// for the empty `user:@host` form too (Node makes no null/empty distinction
// here). Userinfo never appears in host, hostname, or origin.
const none = new URL("http://example.com/a");
const userOnly = new URL("http://user@e.com/");
const both = new URL("http://user:pw@example.com:99/p");
const emptyPassword = new URL("http://user:@e.com/");
const encoded = new URL("http://%75ser:p%40ss@a.com/");
const colonInPassword = new URL("http://user:p:w@a.com/");
const passwordOnly = new URL("http://:pw@e.com/");
const emptyBoth = new URL("http://:@e.com/");
const emptyUserinfo = new URL("http://@e.com/");
const opaque = new URL("mailto:x@y.com");
const fileUrl = new URL("file:///tmp/x");
console.log(`<${none.username}> <${none.password}>`);
console.log(`<${userOnly.username}> <${userOnly.password}>`);
console.log(`<${both.username}> <${both.password}>`);
console.log(`<${emptyPassword.username}> <${emptyPassword.password}>`);
console.log(`<${encoded.username}> <${encoded.password}>`);
console.log(`<${colonInPassword.username}> <${colonInPassword.password}>`);
console.log(`<${passwordOnly.username}> <${passwordOnly.password}>`);
console.log(`<${emptyBoth.username}> <${emptyBoth.password}>`);
console.log(`<${emptyUserinfo.username}> <${emptyUserinfo.password}>`);
console.log(`<${opaque.username}> <${opaque.password}>`);
console.log(`<${fileUrl.username}> <${fileUrl.password}>`);
// Userinfo is carried by href but excluded from host/hostname/origin.
console.log(both.href);
console.log(both.host, both.hostname, both.origin);
console.log(userOnly.href, userOnly.origin);
// An EMPTY password drops its ':' from the serialization; an empty userinfo
// drops the '@' as well.
console.log(emptyPassword.href);
console.log(passwordOnly.href);
console.log(emptyBoth.href);
console.log(emptyUserinfo.href);
// Absent userinfo means both components are the empty string, not undefined.
console.log(none.username.length, none.password.length);
console.log(none.username === "" && none.password === "");
// Composes with unions.
const maybe: URL | undefined = both;
console.log(maybe !== undefined ? maybe.username : "none");
