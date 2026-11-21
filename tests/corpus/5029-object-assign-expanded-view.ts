interface Options {
  schema: unknown;
  resolveKnownTags?: boolean;
  extra?: string;
}

function consume(options: Options): void {
  console.log(String(options.schema));
  console.log(options.resolveKnownTags === true);
  console.log(options.extra);
}

const narrow = { resolveKnownTags: true, schema: "core" };
consume(Object.assign(narrow, { extra: "ok" }));
