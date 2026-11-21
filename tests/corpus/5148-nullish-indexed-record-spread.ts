interface Preferences {
  fresh: number;
}

interface Config extends Record<string, unknown> {
  schema: 1;
  preferences: Preferences;
}

function legacy(): Config {
  return { schema: 1, extra: "preserved", preferences: { fresh: 0 } };
}

function loadCurrent(useCurrent: boolean): Config | null {
  return useCurrent ? legacy() : null;
}

const current = loadCurrent(false);
const next = {
  ...(current ?? legacy()),
  preferences: { ...(current?.preferences ?? {}), fresh: 7 },
};

function validate(config: Config): void {
  console.log(String(JSON.stringify(config)));
}

validate(next);
