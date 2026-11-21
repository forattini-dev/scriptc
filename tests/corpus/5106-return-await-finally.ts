function makePromise(): Promise<number> {
  throw new Error("synchronous");
}
function failCleanup(): void {
  throw new Error("cleanup error");
}
async function guarded(fail: boolean): Promise<number> {
  if (fail) {
    try {
      return await Promise.reject(new Error("failure"));
    } finally {
      console.log("cleanup failure");
    }
  }
  try {
    return await Promise.resolve(4);
  } finally {
    console.log("cleanup success");
  }
}

async function synchronousFailure(): Promise<number> {
  try {
    return await makePromise();
  } finally {
    console.log("cleanup synchronous");
  }
}

async function cleanupFailure(): Promise<number> {
  try {
    return await Promise.resolve(1);
  } finally {
    failCleanup();
  }
}

async function main(): Promise<void> {
  const values = await Promise.all([
    guarded(false), guarded(true).catch(() => 9),
    synchronousFailure().catch(() => 5), cleanupFailure().catch(() => 6),
  ]);
  console.log(values.join(","));
}
void main();
