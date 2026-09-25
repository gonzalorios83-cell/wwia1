import type { MatchCommand } from "./commands";

export type SimulationClock = { tick: number; gameTime: number };

export type CommandBuffer = {
  pending: MatchCommand[];
  sequence: number;
};

export const createSimulationClock = (gameTime = 0, tick = Math.max(0, Math.floor(gameTime * 60))): SimulationClock => ({ tick, gameTime });

export const advanceSimulationClock = (clock: SimulationClock, deltaSeconds: number): SimulationClock => ({
  tick: clock.tick + 1,
  gameTime: clock.gameTime + Math.max(0, deltaSeconds),
});

export const createCommandBuffer = (): CommandBuffer => ({ pending: [], sequence: 0 });

/**
 * Commands are recorded at the simulation boundary before the current local
 * implementation applies them.  A future authoritative server can consume
 * this exact buffer without changing the UI event handlers again.
 */
export const enqueueSimulationCommand = (buffer: CommandBuffer, command: MatchCommand): void => {
  buffer.pending.push(command);
  buffer.sequence += 1;
};

export const drainSimulationCommands = (buffer: CommandBuffer): MatchCommand[] => {
  const pending = buffer.pending;
  buffer.pending = [];
  return pending;
};
