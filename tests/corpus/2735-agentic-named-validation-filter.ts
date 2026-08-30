interface Lease {
  readonly version: 1;
  readonly id: string;
}

function isLease(value: unknown): value is Lease {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return lease.version === 1 && typeof lease.id === "string" && lease.id !== "";
}

const restored: readonly Lease[] = [
  { version: 1, id: "first" },
  { version: 1, id: "second" },
];
const kept = restored.filter(isLease);
console.log(kept.length, kept.map((lease) => lease.id).join(","));
