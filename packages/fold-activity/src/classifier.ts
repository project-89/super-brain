import type {
  TerminalClassification,
  TerminalState,
  TerminalStateRule,
} from "./types.js";

export const DEFAULT_TERMINAL_STATE_RULES: readonly TerminalStateRule[] = [
  {
    id: "awaiting_input_claude_interrupted",
    state: "awaiting_input",
    pattern: /interrupted\s*·\s*what should claude do instead\?/i,
    priority: 115,
    source: "claude",
  },
  {
    id: "awaiting_approval_claude_menu",
    state: "awaiting_approval",
    pattern: /do you want to proceed\?.*(?:1\.\s*yes|2\.\s*yes,?\s*and\s*don.?t\s*ask\s*again)|yes,?\s*and\s*don.?t\s*ask\s*again/i,
    priority: 112,
    source: "claude",
  },
  {
    id: "awaiting_approval_codex",
    state: "awaiting_approval",
    pattern: /would.?you.?like.?to.?run.?the.?following.?command|would.?you.?like.?to.?make.?the.?following.?edits|approve.?access/i,
    priority: 100,
    source: "codex",
  },
  {
    id: "awaiting_approval_gemini",
    state: "awaiting_approval",
    pattern: /apply.?this.?change|allow.?execution|allow.?execution.?of.?mcp.?tool|do.?you.?want.?to.?proceed/i,
    priority: 95,
    source: "gemini",
  },
  {
    id: "awaiting_auth",
    state: "awaiting_auth",
    pattern: /waiting.?for.?auth|api.?key|device.?code|finish.?signing.?in.?via.?your.?browser/i,
    priority: 90,
  },
  {
    id: "awaiting_input_shell",
    state: "awaiting_input",
    pattern: /interactive.?shell.?awaiting.?input|press.?tab.?to.?focus.?shell|continue\?.?\([yY]\/[nN]\)/i,
    priority: 96,
  },
  {
    id: "busy_status_line",
    state: "busy_streaming",
    pattern: /plan mode on|esc.?to.?interrupt|esc.?to.?cancel|waiting.?for.?background.?terminal|booting.?mcp|\b[a-z][a-z-]{4,}ing…\b/i,
    priority: 88,
  },
  {
    id: "ready_prompt_gemini_after_cancel",
    state: "ready_for_input",
    pattern: /request.?cancelled.*(?:type.?your.?message|@path\/to\/file)|press.?ctrl\+c.?again.?to.?exit.*(?:type.?your.?message|@path\/to\/file)/i,
    priority: 82,
    source: "gemini",
  },
  {
    id: "ready_prompt_claude",
    state: "ready_for_input",
    pattern: /(?:^|\s)(?:❯|›)\s*(?:try\s*"[^"]*")?\s*(?:\?\s*for shortcuts)?\s*$/im,
    priority: 76,
    source: "claude",
  },
  {
    id: "ready_prompt_codex",
    state: "ready_for_input",
    pattern: /(?:^|\s)›\s+.+|ask.?codex.?to.?do.?anything|explain.?this.?codebase|summarize.?recent.?commits/i,
    priority: 70,
    source: "codex",
  },
  {
    id: "ready_prompt_gemini",
    state: "ready_for_input",
    pattern: /type.?your.?message.?or.?@path\/to\/file|^\s*[>!*]\s+/im,
    priority: 65,
    source: "gemini",
  },
  {
    id: "completed_claude_duration",
    state: "completed",
    pattern: /cooked.?for.?\d+(?:h\s+\d+m\s+\d+s|m\s+\d+s|s)/i,
    priority: 60,
    source: "claude",
  },
];

export function mergeTerminalStateRules(
  customRules: readonly TerminalStateRule[] = [],
): TerminalStateRule[] {
  return [...DEFAULT_TERMINAL_STATE_RULES, ...customRules].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
  );
}

export function classifyTerminalState(
  normalizedTail: string,
  rules: readonly TerminalStateRule[] = DEFAULT_TERMINAL_STATE_RULES,
  source?: string,
): TerminalClassification {
  if (normalizedTail.length === 0) return { state: "unknown", confidence: 0.1 };

  const recentTail = normalizedTail.slice(-4_000);
  const matches: Array<{ rule: TerminalStateRule; index: number }> = [];
  for (const rule of rules) {
    if (rule.source !== undefined && source !== undefined && rule.source !== source) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/g/g, ""));
    const index = recentTail.search(pattern);
    if (index >= 0) matches.push({ rule, index });
  }
  if (matches.length === 0) return { state: "unknown", confidence: 0.2 };

  matches.sort((left, right) => {
    if (left.index !== right.index) return right.index - left.index;
    return (right.rule.priority ?? 0) - (left.rule.priority ?? 0);
  });

  let selected = matches[0]!;
  if (source === "gemini" && selected.rule.state === "ready_for_input") {
    const conflicts = matches.filter(
      ({ rule, index }) =>
        rule.state !== "ready_for_input" &&
        rule.state !== "completed" &&
        index >= Math.max(0, recentTail.length - 1_600),
    );
    conflicts.sort((left, right) => {
      if ((left.rule.priority ?? 0) !== (right.rule.priority ?? 0)) {
        return (right.rule.priority ?? 0) - (left.rule.priority ?? 0);
      }
      return right.index - left.index;
    });
    if (selected.rule.id !== "ready_prompt_gemini_after_cancel" && conflicts[0]) {
      selected = conflicts[0];
    }
  }

  return {
    state: selected.rule.state,
    ruleId: selected.rule.id,
    confidence: 0.75 + Math.min((selected.rule.priority ?? 0) / 1_000, 0.2),
  };
}

export function isActiveTerminalState(state: TerminalState): boolean {
  return (
    state === "busy_streaming" ||
    state === "awaiting_input" ||
    state === "awaiting_approval" ||
    state === "awaiting_auth"
  );
}
