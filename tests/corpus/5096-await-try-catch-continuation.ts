async function flow(fail: boolean, after: boolean): Promise<boolean> {
  let reached = false;
  try {
    reached = await (fail
      ? Promise.reject(new Error("no"))
      : Promise.resolve(true));
  } catch (error) {
    return error instanceof Error;
  }
  if (after) {
    await Promise.resolve(undefined);
  }
  return reached;
}

async function main(): Promise<void> {
  const values = await Promise.all([
    flow(true, false),
    flow(false, false),
    flow(false, true),
  ]);
  console.log(values.join(","));
}

void main();
