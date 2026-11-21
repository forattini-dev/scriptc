const platforms = ["desktop", "wsl", "windows"] as const;
const action: { platforms: readonly string[] } = { platforms };
console.log(action.platforms.join(","));
