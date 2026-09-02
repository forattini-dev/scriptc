// @dynamic
// A Request constructed in user TypeScript remains a first-class Fetch input
// and exposes the URL and default method selected by the Web API.
const request = new Request(`${process.argv[2]}/text`);
const response = await fetch(request);
const method: string = request.method;
const url: string = request.url;
const body: string = await response.text();
console.log(method, url.endsWith("/text"), body);
