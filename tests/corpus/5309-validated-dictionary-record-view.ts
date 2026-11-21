type Surface = {
  id: string;
  role: string;
  os: string;
  distro: string;
  version: string;
  arch: string;
  env: string;
};

const entry: Record<string, unknown> = {
  id: 'desk',
  role: 'developer',
  os: 'linux',
  distro: 'ubuntu',
  version: '24.04',
  arch: 'x64',
  env: 'native',
};

const surfaces: Surface[] = [];
surfaces.push(entry as unknown as Surface);
console.log(surfaces[0].id);
console.log(`${surfaces[0].os}/${surfaces[0].arch}/${surfaces[0].env}`);
