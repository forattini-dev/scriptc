/// <reference types="node" />

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

console.log(alive(process.pid));
