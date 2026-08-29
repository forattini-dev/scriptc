// @dynamic
function hasObjectBuckets(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.buckets) && record.buckets.length === 2 && record.buckets.every((bucket) => {
    if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) return false;
    const point = bucket as Record<string, unknown>;
    return typeof point.hour === "string" &&
      (point.value === null || typeof point.value === "number") &&
      (point.absent_reason === null || typeof point.absent_reason === "string");
  });
}

console.log(hasObjectBuckets({ buckets: [
  { hour: "one", value: 1, absent_reason: null },
  { hour: "two", value: null, absent_reason: "missing" },
] }));
console.log(hasObjectBuckets({ buckets: [
  { hour: "one", value: 1, absent_reason: null },
  [],
] }));
console.log(hasObjectBuckets({ buckets: "not-an-array" }));
console.log(hasObjectBuckets([]));
