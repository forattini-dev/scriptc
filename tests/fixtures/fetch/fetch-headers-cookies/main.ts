// @dynamic
// Headers.getSetCookie() is a Node 24/26 Web API surface. Exercise it
// through a real Response so the native binary and Node oracle must agree.
const response = await fetch(`${process.argv[2]}/header-echo`);
console.log(JSON.stringify(response.headers.getSetCookie()));
