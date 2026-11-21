async function wake(
  cwd: string,
  wakeResident: (cwd: string) => void | Promise<void>,
): Promise<void> {
  await Promise.resolve(wakeResident(cwd));
}

wake("here", () => console.log("awake"));
