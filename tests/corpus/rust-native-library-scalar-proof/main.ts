function getString(value: unknown, defaultValue = ""): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "default" in value) {
    return String((value as { default: unknown }).default);
  }
  return defaultValue;
}

async function download(positional: Record<string, unknown>): Promise<string> {
  const pathMod = await import("node:path");
  const remote = getString(positional.remote);
  const local = getString(positional.local) || pathMod.basename(remote);
  const user = getString(positional.user, "anonymous");
  return `${user} ${remote} -> ${local} (${pathMod.extname(remote) || "none"})`;
}

async function main(): Promise<void> {
  console.log(await download({ remote: "/pub/files/archive.tar.gz" }));
  console.log(await download({ remote: "/etc/motd", local: "motd.txt", user: "ops" }));
  console.log(await download({ remote: { default: "/var/log/app.log" } }));
  console.log(await download({}));
}

main();
