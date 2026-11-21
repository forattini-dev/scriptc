export function localPath(value: string, environment: "wsl" | "windows"): string {
  if (environment !== "wsl") return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match?.[1]) return value;
  return `/mnt/${match[1].toLowerCase()}/${(match[2] ?? "").replace(/\\/g, "/")}`;
}
