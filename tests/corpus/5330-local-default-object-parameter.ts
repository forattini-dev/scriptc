type Worker = { readonly id: string };

function main(): void {
  function record(
    event: "worker-death" | "worker-birth",
    worker: Worker,
    detail: string | null,
    exit: { readonly exitCode?: number | null; readonly signal?: string | null } = {},
  ): void {
    console.log(event, worker.id, detail, exit.exitCode ?? "none");
  }

  const dead: Worker[] = [{ id: "worker-1" }];
  for (const worker of dead) {
    record("worker-death", worker, "ended while no daemon was watching");
  }
}

main();
