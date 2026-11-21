import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'powershell.exe' : 'sleep';
const args = process.platform === 'win32'
  ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']
  : ['30'];
const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
console.log(child.signalCode);
child.on('close', () => console.log(child.exitCode, child.signalCode));
child.kill('SIGTERM');
