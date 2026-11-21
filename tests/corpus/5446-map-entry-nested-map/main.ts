class NestedMaps {
  private domains = new Map<string, Map<string, Map<string, number>>>();
  private paths = new Map<string, Map<string, number>>();
  private rootNames = new Map<string, number>();
  private apiNames = new Map<string, number>();

  seed(): void {
    this.rootNames.set("session", 7);
    this.apiNames.set("token", 9);
    this.paths.set("/", this.rootNames);
    this.paths.set("/api", this.apiNames);
    this.domains.set("example.com", this.paths);
  }

  output(): string {
    const output: string[] = [];
    for (const [domain, paths] of this.domains.entries()) {
      for (const [path, names] of paths.entries()) {
        for (const [name, value] of names) {
          output.push(`${domain}${path}:${name}=${value}`);
        }
      }
    }
    return output.join("|");
  }
}

const maps = new NestedMaps();
maps.seed();
console.log(JSON.stringify(maps.output()));
