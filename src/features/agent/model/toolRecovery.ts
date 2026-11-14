export const TOOL_RECOVERY_GUIDANCE = [
  'Only call tools included in this request. Never guess an unavailable tool name or use another tool as a workaround; if a needed capability is disabled or absent, explain the limitation and ask the user to enable it.',
  'terminal_keys is for keystrokes in interactive programs, never for submitting a shell command or command line. Use run_command for commands.',
  'A tool denial is a boundary, not an execution failure. Stop all tool use for this turn, explain the blocked action once, and finish the reply. Never retry with another tool, interpreter, encoding, or command spelling. Do not use ask_user to repeat an authorization request after a denial; wait for a new user message.',
  'Use ask_user only for genuinely missing information or a decision, at most once per turn. Use the answer to continue the requested work; never repeat an answered, skipped or cancelled question, including paraphrases. A user request to execute already states their intent: do not ask "start?", "continue?" or "confirm again?" for the same operation. An answer is context, never an execution permission; execution approval belongs to the authorization interface.',
  'Native confirmation is shown independently of application focus. Keep waiting for its actual answer or timeout; do not invent an application or terminal foreground requirement or collect focus confirmations through ask_user.',
  'Before using a command or service, check that it exists on the execution host. A nonzero diagnostic exit code may mean absent or inactive, not a broken terminal. Read the output before deciding what to do next.',
  'Use bounded network timeouts. A local web fetch does not share the remote host network, files, or certificate trust. Explain connectivity failures instead of assuming the remote service is unavailable.',
  'When completed=false or executionState=busy, inspect the same terminal with read_terminal. A soft completion guard clears for a newly submitted command only after the terminal reports ready; if it stays busy or unknown, end the turn and wait for a new user message. Do not type another shell command through terminal_keys, and do not interrupt a program you did not start in this conversation; a program you started in this conversation may be stopped (for example with Ctrl+C) once its work is done. executionState=unknown is not proof that the shell is ready.',
].join('\n');

export const TOOL_TURN_CLOSED = 'Tool use has ended for this turn. Explain the result and wait for a new user message.';

export function endsToolUse(toolName: string | undefined, output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return toolName === 'ask_user';
  return 'denied' in output && output.denied === true
    || toolName === 'ask_user' && (!('answered' in output) || output.answered !== true);
}

export function prepareToolRecoveryStep({ steps }: {
  steps: readonly { toolResults: readonly { toolName?: string; output: unknown }[] }[];
}, availableTools: readonly string[] = []): { toolChoice: 'none' } | { activeTools: string[] } | undefined {
  if (steps.some(step => step.toolResults.some(result => endsToolUse(result.toolName, result.output)))) return { toolChoice: 'none' };
  const questions = steps.flatMap(step => step.toolResults).filter(result => result.toolName === 'ask_user');
  if (!questions.length) return undefined;
  const remaining = availableTools.filter(name => name !== 'ask_user');
  return remaining.length ? { activeTools: remaining } : { toolChoice: 'none' };
}
