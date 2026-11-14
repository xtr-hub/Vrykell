import { t } from '@i18n';
import { useTerminalStore } from '@features/terminal/stores/terminal';
import { useBlockStore } from '@features/terminal/stores/blocks';
import { completionRecoveryReady } from '@features/terminal/services/commandCompletion';
import { agentControl } from './agentControl';

export type TerminalExecutionState = 'busy' | 'ready' | 'interactive' | 'unknown';

export function terminalDisconnected(paneId: string, expectedSessionId?: string) {
  const state = useTerminalStore.getState();
  if (state.sessions[paneId] && (!expectedSessionId || state.sessions[paneId] === expectedSessionId) && state.startupStates[paneId] !== 'closed' && state.startupStates[paneId] !== 'failed') return null;
  return { ok: false as const, completed: false, output: '', code: 'TERMINAL_DISCONNECTED', requiresUserAction: true,
    error: t('The selected execution terminal disconnected. The command was not confirmed as completed. Ask the user to reconnect or select another terminal; do not switch targets or retry automatically.') };
}

/** One readiness definition for tools and recovery guards: a quiet classic screen is never "ready". */
export function terminalExecutionState(paneId: string): TerminalExecutionState {
  if (terminalDisconnected(paneId)) return 'unknown';
  const blocks = useBlockStore.getState().byTab[paneId] ?? [];
  if (agentControl.isControlled(paneId) || blocks.some(block => block.status === 'executing' || block.snapshotPending)) return 'busy';
  const scene = useTerminalStore.getState().scenes[paneId];
  if (scene === 'altScreen') return 'interactive';
  if (scene === 'blockList') return 'ready';
  // A classic screen is not ready on silence alone. A retained marker from the command whose
  // wait timed out is positive evidence that this shell reached a prompt again.
  if (completionRecoveryReady(paneId)) return 'ready';
  return 'unknown';
}

/** A soft command guard may clear only when the same readiness check accepts another write. */
export function terminalCommandReady(paneId: string): boolean {
  return terminalExecutionState(paneId) === 'ready';
}
