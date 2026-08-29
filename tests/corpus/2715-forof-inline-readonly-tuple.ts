// @dynamic
// Inline registry tuples must evaluate their elements once before iteration.
function hasRequiredStrings(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const field of ["start_time", "session_key_hash", "socket_path"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0) return false;
  }
  return true;
}

console.log(hasRequiredStrings({
  start_time: "now",
  session_key_hash: "abc",
  socket_path: "/tmp/daemon.sock",
}));
console.log(hasRequiredStrings({
  start_time: "now",
  session_key_hash: "",
  socket_path: "/tmp/daemon.sock",
}));
