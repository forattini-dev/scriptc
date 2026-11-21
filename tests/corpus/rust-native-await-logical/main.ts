async function stopWorker(id: string): Promise<boolean> {
  console.log("stopping", id);
  await Promise.resolve();
  return id !== "stuck";
}

async function runCommand(id: string | null): Promise<string> {
  const stopped = id != null && await stopWorker(id);
  console.log("after and", id, stopped);
  const skipped = id == null || await stopWorker(`${id}-again`);
  console.log("after or", id, skipped);
  return stopped ? `stopped ${id}` : `nothing for ${id}`;
}

async function main(): Promise<void> {
  console.log(await runCommand("w1"));
  console.log(await runCommand(null));
  console.log(await runCommand("stuck"));
}

main().then(() => console.log("done"));
console.log("scheduled");
