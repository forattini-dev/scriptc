// @dynamic
// The Headers iterator is the canonical normalized entry view: sorted names
// with repeated field values combined, independent of wire arrival order.
const response = await fetch(`${process.argv[2]}/header-echo`);
const fields = [...response.headers]
  .filter(([name]) => name.startsWith("x-"));
console.log(JSON.stringify(fields));
