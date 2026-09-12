// Native ESM entry checks use module identity. import.meta.url identifies
// the source module, while process.argv[1] identifies the compiled executable.
console.log(import.meta.main);
console.log(new URL(import.meta.url).protocol);
