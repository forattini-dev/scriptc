// @rust-only
// @no-engine
// @ts-nocheck

interface BoxProps {
  "aria-label"?: string;
  width?: number;
}

function Box(props: BoxProps): string {
  return props["aria-label"] ?? "missing";
}

console.log(
  Box({
    __contextProvider: true,
    "aria-label": "Context Provider",
  }),
);
