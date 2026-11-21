// Untyped JavaScript: the selected parser is either a schema or a getter.
function selectParser(kind) {
  if (kind === "lazy") {
    return () => ({ type: "object", lazy: true });
  }
  return kind === "none" ? undefined : { type: kind };
}

export function parseDefJs(kind) {
  const jsonSchemaOrGetter = selectParser(kind);
  const jsonSchema = typeof jsonSchemaOrGetter === "function"
    ? jsonSchemaOrGetter()
    : jsonSchemaOrGetter;
  return jsonSchema;
}
