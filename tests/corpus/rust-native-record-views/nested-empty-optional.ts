type Parsed = { rest: string[]; values: {} };
type Flags = { rest: string[]; values: { brief?: boolean; query?: string } };

const parsed: Parsed = { rest: ["go"], values: {} };
const flags: Flags = parsed;
console.log(flags.rest.join(","), flags.values.brief, flags.values.query);
