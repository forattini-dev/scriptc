  builtins.os = memo(() => {
    const plat = host.platform();
    const os = {
      EOL: plat === 'win32' ? '\r\n' : '\n',
      platform: () => plat,
      arch: () => host.arch(),
      hostname: () => host.hostname(),
      homedir: () => host.homedir(),
      tmpdir: () => host.tmpdir(),
      type: () => (plat === 'darwin' ? 'Darwin' : plat === 'win32' ? 'Windows_NT' : 'Linux'),
      endianness: () => 'LE',
      userInfo: () => {
        const ids = host.ids();
        const env = builtins.process().env;
        return {
          uid: ids[0],
          gid: ids[1],
          username: env.USER || env.USERNAME || env.LOGNAME || '',
          homedir: host.homedir(),
          shell: plat === 'win32' ? null : env.SHELL || null,
        };
      },
    /* The inert half: values Node reads from the kernel that the island
     * does not carry — empty-but-typed answers, never throws. */
      release: () => '',
      version: () => '',
      machine: () => (host.arch() === 'arm64' ? 'arm64' : host.arch() === 'x64' ? 'x86_64' : host.arch()),
      cpus: () => [],
      availableParallelism: () => 1,
      totalmem: () => 0,
      freemem: () => 0,
      loadavg: () => [0, 0, 0],
      uptime: () => 0,
      networkInterfaces: () => ({}),
      constants: {
        signals: host.signals(),
        errno: {},
        priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
      },
    };
    os.default = os;
    return os;
  });
