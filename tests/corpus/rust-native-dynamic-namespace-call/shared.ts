const ADOPTABLE: Record<string, string> = { git: ".gitconfig", zsh: ".zshrc" };

export function adoptableTools(): string[] {
  return Object.keys(ADOPTABLE);
}

export async function adoptConfig(tool: string): Promise<number> {
  if (!(tool in ADOPTABLE)) {
    throw new Error(`cannot share ${tool}'s configuration — try one of: ${adoptableTools().join(", ")}`);
  }
  return ADOPTABLE[tool]!.length;
}
