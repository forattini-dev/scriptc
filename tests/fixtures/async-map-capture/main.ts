async function run() {
  const prefix = 'item';
  const promises = [1, 2].map(async value => `${prefix}:${value}`);
  console.log(JSON.stringify(await Promise.all(promises)));
}
void run();
