// @rust-only
// @no-engine

interface Context {
  current: string;
  Provider: (label: string) => string;
}

function createContext(defaultValue: string): Context {
  const context = {
    current: defaultValue,
    Provider: (label: string): string => `${context.current}:${label}`,
  };
  return context;
}

const context = createContext("root");
console.log(context.Provider("leaf"));
