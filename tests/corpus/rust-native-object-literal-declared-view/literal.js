export function parseLiteralDef(value, target) {
  const parsedType = typeof value;
  if (parsedType !== "bigint" && parsedType !== "number" && parsedType !== "boolean" && parsedType !== "string") {
    return {
      type: Array.isArray(value) ? "array" : "object",
    };
  }
  if (target === "openApi3") {
    return {
      type: parsedType === "bigint" ? "integer" : parsedType,
      enum: [value],
    };
  }
  return {
    type: parsedType === "bigint" ? "integer" : parsedType,
    const: value,
  };
}
