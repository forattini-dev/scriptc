// @rust-only
function run(): void {
  const state = { files: new Map<string, string>(), shell: new Map<string, string>() };
  const register = <K extends "files" | "shell">(key: K, value: string): void => {
    const map = state[key];
    map.set(key, value);
  };
  register("files", "disk");
  register("shell", "terminal");
  console.log(state.files.size, state.shell.size);
  console.log(state.files.get("files"), state.shell.get("shell"));
}
run();
