    /* node:constants — the deprecated flat merge (os signals + fs
     * flags + the crypto slice), same numbers the platform hooks
     * answer everywhere else. */
  builtins.constants = memo(() => {
    const c = { ...host.signals(), ...host.fsConstants(), ...builtins.crypto().constants };
    c.default = c;
    return c;
  });
