function finish(callback) {
  queueMicrotask(() => callback(null, 'READY'));
}

function fail(callback) {
  queueMicrotask(() => callback(new Error('failed')));
}

async function main() {
  const finishAsync = require('node:util').promisify(finish);
  const failAsync = require('node:util').promisify(fail);
  console.log(await finishAsync());
  try {
    await failAsync();
  } catch (error) {
    console.log(error.name, error.message);
  }
}

main();
