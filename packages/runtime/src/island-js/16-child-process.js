  builtins.child_process = memo(() => {
    const die = (name) => () => {
      throw new Error('child_process.' + name + ' is not available in the scriptc island');
    };
    const cp = {};
    for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[n] = die(n);
    cp.default = cp;
    return cp;
  });
