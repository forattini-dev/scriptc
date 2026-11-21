async function check(active: boolean): Promise<string> {
  console.log("before");
  const value = await Promise.resolve("ok");
  let suffix = "";
  if (active) suffix = "!";
  if (!active) suffix = "?";
  return value + suffix;
}
async function main(): Promise<void> {
  const values = await Promise.all([check(true), check(false)]);
  console.log(values.join(","));
}
void main();
