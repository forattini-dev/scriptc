/// <reference types="node" />
// @no-engine
// Both members must retain their typed Promise payload through computed dispatch.
async function read(selectText: boolean): Promise<void> {
  const response = new Response("abc");
  const member: "text" | "bytes" = selectText ? "text" : "bytes";
  const body: string | Uint8Array = await response[member]();
  console.log(member, typeof body, response.bodyUsed);
  if (typeof body === "string") console.log(body.length, body);
  else console.log(body.length, body[0], body[1], body[2]);
}

await read(true);
await read(false);
