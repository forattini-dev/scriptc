// @rust-only
// @no-engine

function style(width: number | undefined): {
  flexDirection: string;
  width?: number;
  padding: number;
  metadata?: unknown;
} {
  return {
    flexDirection: "column",
    ...(width !== undefined ? { width } : undefined),
    padding: 2,
  };
}

const absent = style(undefined);
const present = style(8);
console.log(`${absent.flexDirection}|${absent.padding}|${"width" in absent}`);
console.log(
  `${present.flexDirection}|${present.padding}|${present.width === 8}`,
);
