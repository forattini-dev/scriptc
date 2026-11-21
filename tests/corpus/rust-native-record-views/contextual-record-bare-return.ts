function buildRecord(skip: boolean): { value: number } {
  if (skip) {
    // @ts-expect-error This branch intentionally returns no record.
    return;
  }
  const record = { value: 42 };
  return record;
}

console.log(buildRecord(false).value);
