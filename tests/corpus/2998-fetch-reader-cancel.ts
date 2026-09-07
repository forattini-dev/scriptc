async function main(): Promise<void> {
  const response = new Response("abcdef");
  const body = response.body!;
  const reader = body.getReader();
  console.log(response.bodyUsed, body.locked);
  await reader.cancel();
  console.log((await reader.read()).done, response.bodyUsed, body.locked);
  reader.releaseLock();
  console.log(body.locked);
  const replacement = body.getReader();
  console.log((await replacement.read()).done);
  replacement.releaseLock();
}
void main();
