export function choose({name = "D", ...rest}) {
  return String(name) + ":" + Object.keys(rest).join("|");
}
