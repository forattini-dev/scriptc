// @rust-only
// @no-engine

type Theme = {
  colors: { accent: string | null };
  symbols: { question: string };
};

const raw: { colors: any; symbols: any } = {
  colors: { accent: "cyan" },
  symbols: { question: "?" },
};
const theme: Theme = raw;

console.log(theme.colors.accent);
console.log(theme.symbols.question);
