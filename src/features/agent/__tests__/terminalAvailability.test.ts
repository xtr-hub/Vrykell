import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBlockStore } from '@features/terminal/stores/blocks';
import { useTerminalStore } from '@features/terminal/stores/terminal';
import { completionRecoveryReady } from '@features/terminal/services/commandCompletion';
import { agentControl } from '../services/agentControl';
import { terminalCommandReady, terminalExecutionState } from '../services/terminalAvailability';

vi.mock('@features/terminal/services/commandCompletion', () => ({ completionRecoveryReady: vi.fn(() => false) }));

const initialTerm = useTerminalStore.getState();
const initialBlocks = useBlockStore.getState();
const paneId = 'readiness-pane';

beforeEach(() => {
  vi.mocked(completionRecoveryReady).mockReturnValue(false);
  useTerminalStore.setState({
    sessions: { [paneId]: 'pty-readiness' },
    startupStates: { [paneId]: 'ready' },
    scenes: { [paneId]: 'blockList' },
  });
  useBlockStore.setState({ byTab: {} });
});

afterEach(() => {
  agentControl.release(paneId);
  useTerminalStore.setState(initialTerm, true);
  useBlockStore.setState(initialBlocks, true);
});

it('reports ready only for an idle integrated block list', () => {
  expect(terminalExecutionState(paneId)).toBe('ready');
  expect(terminalCommandReady(paneId)).toBe(true);

  useBlockStore.setState({ byTab: { [paneId]: [{ status: 'executing' } as never] } });
  expect(terminalExecutionState(paneId)).toBe('busy');
  expect(terminalCommandReady(paneId)).toBe(false);

  useBlockStore.setState({ byTab: { [paneId]: [{ status: 'done', snapshotPending: true } as never] } });
  expect(terminalExecutionState(paneId)).toBe('busy');
  expect(terminalCommandReady(paneId)).toBe(false);

  useBlockStore.setState({ byTab: { [paneId]: [{ status: 'interrupted' } as never] } });
  expect(terminalExecutionState(paneId)).toBe('ready');
  expect(terminalCommandReady(paneId)).toBe(true);
});

it('lets a late completion marker prove a classic shell is ready again', () => {
  useTerminalStore.setState((state) => ({ scenes: { ...state.scenes, [paneId]: 'classic' } }));
  expect(terminalExecutionState(paneId)).toBe('unknown');
  vi.mocked(completionRecoveryReady).mockReturnValue(true);
  expect(terminalExecutionState(paneId)).toBe('ready');
  expect(terminalCommandReady(paneId)).toBe(true);
});

it('never treats a classic screen or a controlled pane as ready', () => {
  useTerminalStore.setState((state) => ({ scenes: { ...state.scenes, [paneId]: 'classic' } }));
  expect(terminalExecutionState(paneId)).toBe('unknown');
  expect(terminalCommandReady(paneId)).toBe(false);

  useTerminalStore.setState((state) => ({ scenes: { ...state.scenes, [paneId]: 'blockList' } }));
  agentControl.acquire(paneId);
  expect(terminalExecutionState(paneId)).toBe('busy');
  expect(terminalCommandReady(paneId)).toBe(false);
  agentControl.release(paneId);
  expect(terminalCommandReady(paneId)).toBe(true);
});

it('reports a disconnected or fullscreen pane as unavailable', () => {
  useTerminalStore.setState({ sessions: { [paneId]: 'pty-readiness' }, startupStates: { [paneId]: 'closed' }, scenes: { [paneId]: 'blockList' } });
  expect(terminalExecutionState(paneId)).toBe('unknown');
  expect(terminalCommandReady(paneId)).toBe(false);

  useTerminalStore.setState({ startupStates: { [paneId]: 'ready' }, scenes: { [paneId]: 'altScreen' } });
  expect(terminalExecutionState(paneId)).toBe('interactive');
  expect(terminalCommandReady(paneId)).toBe(false);
});
