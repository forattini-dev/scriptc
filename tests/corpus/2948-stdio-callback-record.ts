interface Hooks {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}
function write(hooks: Hooks): void {
  hooks.stdout("ok");
  hooks.stderr("err");
}
function output(value: string): void { console.log(value); }
write({ stdout: output, stderr: output });
