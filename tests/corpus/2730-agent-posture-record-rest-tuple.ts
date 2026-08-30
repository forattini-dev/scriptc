type AgentId = "redcode" | "codex" | "opencode";

type UnattendedPosture =
  | {
      readonly kind: "launch-args";
      readonly args: readonly [string, ...string[]];
      readonly evidence: string;
    }
  | { readonly kind: "session-mode"; readonly modeId: string; readonly evidence: string }
  | { readonly kind: "none-needed"; readonly reason: string };

const POSTURES: Readonly<Record<AgentId, UnattendedPosture>> = {
  redcode: { kind: "none-needed", reason: "workspace policy" },
  codex: {
    kind: "launch-args",
    args: ["-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"],
    evidence: "unattended write probe",
  },
  opencode: { kind: "session-mode", modeId: "bypassPermissions", evidence: "mode probe" },
};

function printPosture(id: AgentId): void {
  const posture = POSTURES[id];
  if (posture.kind === "launch-args") {
    console.log(id, posture.args.length, posture.args.join("|"), posture.evidence);
  } else if (posture.kind === "session-mode") {
    console.log(id, posture.modeId, posture.evidence);
  } else {
    console.log(id, posture.reason);
  }
}

printPosture("redcode");
printPosture("codex");
printPosture("opencode");
