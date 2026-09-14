export const MAX_INLINE_SANDBOX_COMMAND_BYTES = 768;

export const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Keep long shell programs out of the local CLI's argument vector. The
 * same script records the remote exit status for either transport. */
export function sandboxCommand(command, args, exitMarker) {
  const statusPath = `/tmp/${exitMarker}.status`;
  const script =
    `${[command, ...args].map(shellQuote).join(" ")}; scriptc_status=$?; ` +
    `printf '%s\\n' "$scriptc_status" > ${shellQuote(statusPath)}; ` +
    `printf '\\n${exitMarker}%s\\n' "$scriptc_status"`;
  const scriptPath = `/tmp/${exitMarker}.sh`;
  const file = Buffer.byteLength(script, "utf8") > MAX_INLINE_SANDBOX_COMMAND_BYTES;
  return {
    script,
    scriptPath,
    statusPath,
    file,
    argv: file ? ["sh", scriptPath] : ["sh", "-c", script],
  };
}
