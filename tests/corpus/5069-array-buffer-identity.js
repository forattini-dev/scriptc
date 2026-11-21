/** @param {any} data */
function describe(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return `buffer:${data.byteLength}`;
  if (typeof data === "object" && data !== null && "message" in data) {
    const objectData = data;
    const suffix = "documentation_url" in objectData
      ? ` - ${objectData.documentation_url}`
      : "";
    return `${objectData.message}${suffix}`;
  }
  return "unknown";
}

console.log(describe("text"));
console.log(describe(new ArrayBuffer(4)));
console.log(describe({ message: "failed", documentation_url: "/docs" }));
