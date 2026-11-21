// @rust-only
// @no-engine
// @ts-nocheck

interface BoxProps {
  flexGrow?: number;
  width?: number | string;
  paddingX?: number;
}

function Box(props: BoxProps): string {
  return `${props.flexGrow}|${props.width}|${props.paddingX}`;
}

function render(section: any, padding: any): string {
  const style = {
    flexGrow: section.width === undefined ? section.flexGrow : 0,
    ...(section.width !== undefined ? { width: section.width } : undefined),
    paddingX: padding,
  };
  return Box(style);
}

console.log(render({ flexGrow: 2 }, 1));
console.log(render({ width: 8 }, 3));
