import { spawn, type ChildProcess } from 'node:child_process';

function stop(guard: ChildProcess | undefined): void {
  console.log(guard?.kill('SIGTERM'));
}

const command = process.platform === 'win32' ? 'powershell.exe' : 'sleep';
const args = process.platform === 'win32'
  ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']
  : ['30'];
const guard = spawn(command, args, { stdio: 'ignore', windowsHide: true });
stop(guard);
stop(undefined);
