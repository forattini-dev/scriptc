import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'powershell.exe' : 'sh';
const args = process.platform === 'win32'
  ? ['-NoProfile', '-Command', "[Console]::Error.Write('ERR')"]
  : ['-c', 'printf ERR >&2'];
const child = spawn(command, args, { stdio: 'pipe', windowsHide: true });
child.stderr?.setEncoding('utf8');
child.stderr?.on('data', (chunk: string) => console.log(chunk));
child.on('close', () => console.log('close'));
