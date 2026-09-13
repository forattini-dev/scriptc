/** JSONC syntax validation for a tsconfig text: tsgo's parseConfigFile
 * RECOVERS silently over syntax errors (probed: a hard-broken file answers
 * empty options, no diagnostic), where 5.9.3's readConfigFile reported the
 * first parse error — a preflight-visible difference (broken config: fail
 * loudly, never adopt silently). tsconfig's grammar is JSON plus comments
 * and trailing commas, so stripping exactly those and handing the rest to
 * JSON.parse decides validity without either TypeScript's parser. The
 * MESSAGE is JSON.parse's, not 5.9.3's ("'}' expected.") — the one
 * remaining wording delta on this path, unpinned by any snapshot. */
export function parseConfigJson(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const from = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(from, i + 1);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    out += ch;
  }
  // Trailing commas: `,` followed only by whitespace before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out.trim() === "" ? {} : JSON.parse(out) as unknown;
}

export function jsoncSyntaxError(text: string): string | null {
  try {
    parseConfigJson(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
