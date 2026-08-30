type WorkerEventKind =
  | "worker-birth"
  | "worker-death"
  | "worker-budget-kill"
  | "worker-heartbeat";

const PUBLIC_EVENT_KINDS = [
  "worker-birth",
  "worker-death",
  "worker-budget-kill",
] as const satisfies readonly WorkerEventKind[];

type PublicEventKind = typeof PUBLIC_EVENT_KINDS[number];

function isPublicEventKind(value: string): boolean {
  return PUBLIC_EVENT_KINDS.includes(value as PublicEventKind);
}

for (const kind of ["worker-birth", "worker-heartbeat", "worker-budget-kill"] as const) {
  console.log(kind, isPublicEventKind(kind));
}
