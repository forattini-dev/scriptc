// @ts-nocheck
function options(retry, clustered) {
  const jobOptions = retry ? { priority: 0, weight: 0 } : {};
  if (clustered) {
    jobOptions.expiration = 60_000;
  }
  return jobOptions.expiration ?? -1;
}

console.log(`${options(false, true)}`);
console.log(`${options(true, false)}`);
