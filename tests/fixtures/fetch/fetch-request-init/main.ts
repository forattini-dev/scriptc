// @dynamic
// RequestInit belongs to the constructed Request: fetch(request) must send
// its method, headers, and body rather than falling back to GET defaults.
const request = new Request(`${process.argv[2]}/post-echo`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const response = await fetch(request);
const result = (await response.json()) as {
  method: string;
  contentType: string | null;
  body: string;
};
console.log(result.method, result.contentType, result.body);
