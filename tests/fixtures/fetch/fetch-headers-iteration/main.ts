// @dynamic
// Headers iteration exposes normalized, sorted field names and combines
// repeated non-cookie values before invoking the callback.
const response = await fetch(`${process.argv[2]}/header-echo`);
const fields: string[] = [];
response.headers.forEach((value, name) => {
  if (name.startsWith("x-")) fields.push(`${name}=${value}`);
});
console.log(JSON.stringify(fields));
