async function show(value: Promise<number> | undefined): Promise<void> {
  const dynamic: unknown = value;
  console.log(await dynamic);
}

void show(undefined).then(() => show(Promise.resolve(42)));
