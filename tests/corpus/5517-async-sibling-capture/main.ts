function makeWorkerManager() {
  const workers = new Map<string, number>();
  const reattached = new Set<string>();
  const logs = new Map<string, string>();

  async function command(id: string): Promise<boolean> {
    return await stopWorker(id);
  }

  function clearLogs(id: string): void {
    logs.delete(id);
  }

  function forgetWorker(id: string): void {
    workers.delete(id);
    reattached.delete(id);
    clearLogs(id);
  }

  async function stopWorker(id: string): Promise<boolean> {
    await Promise.resolve();
    forgetWorker(id);
    return !workers.has(id) && !reattached.has(id) && !logs.has(id);
  }

  workers.set("one", 1);
  reattached.add("one");
  logs.set("one", "active");
  return command;
}

const stop = makeWorkerManager();
void stop("one").then((removed) => console.log("removed", removed));
