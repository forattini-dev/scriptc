const getRef = (item, refs) => {
  switch (refs.$refStrategy) {
    case "root":
      return { $ref: item.path.join("/") };
    case "relative":
      return { $ref: JSON.parse(JSON.stringify(item.path)).join("/") };
    default:
      return undefined;
  }
};

export function parseDef(kind, seen) {
  const seenItem = seen.get(kind);
  if (seenItem) {
    const seenSchema = getRef({ path: ["#", "definitions", seenItem] }, { $refStrategy: kind === "user" ? "root" : "relative" });
    if (seenSchema !== undefined) {
      return seenSchema;
    }
  }
  return undefined;
}
