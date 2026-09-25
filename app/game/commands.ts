import type { MatchPoint, PlayerId } from "./types";

export type CommandBase = {
  commandId: string;
  playerId: PlayerId;
  tick: number;
};

export type MoveCommand = CommandBase & {
  type: "move";
  unitIds: number[];
  destination: MatchPoint;
  attackMove?: boolean;
};

export type AttackCommand = CommandBase & {
  type: "attack";
  unitIds: number[];
  targetId: number;
};

export type BuildCommand = CommandBase & {
  type: "build";
  buildingType: string;
  position: MatchPoint;
  buildingId?: number;
};

export type ProduceCommand = CommandBase & {
  type: "produce";
  buildingId: number;
  unitType: string;
};

export type CancelCommand = CommandBase & {
  type: "cancel";
  unitIds?: number[];
  buildingId?: number;
  queueIndex?: number;
};

export type CaptureCommand = CommandBase & {
  type: "capture";
  unitIds: number[];
  targetId: number;
};

export type MarketCommand = CommandBase & {
  type: "market";
  action: "buy" | "sell" | "loan" | "procure";
  resource?: "materials" | "oil" | "water";
  unitType?: string;
};

export type MatchCommand = MoveCommand | AttackCommand | BuildCommand | ProduceCommand | CancelCommand | CaptureCommand | MarketCommand;

export type CommandDraft =
  | Omit<MoveCommand, "commandId" | "playerId" | "tick">
  | Omit<AttackCommand, "commandId" | "playerId" | "tick">
  | Omit<BuildCommand, "commandId" | "playerId" | "tick">
  | Omit<ProduceCommand, "commandId" | "playerId" | "tick">
  | Omit<CancelCommand, "commandId" | "playerId" | "tick">
  | Omit<CaptureCommand, "commandId" | "playerId" | "tick">
  | Omit<MarketCommand, "commandId" | "playerId" | "tick">;

const COMMAND_TYPES = new Set<MatchCommand["type"]>(["move", "attack", "build", "produce", "cancel", "capture", "market"]);

export const isMatchCommand = (value: unknown): value is MatchCommand => {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<CommandBase> & { type?: unknown };
  return typeof command.commandId === "string"
    && typeof command.playerId === "string"
    && Number.isInteger(command.tick)
    && Number(command.tick) >= 0
    && typeof command.type === "string"
    && COMMAND_TYPES.has(command.type as MatchCommand["type"]);
};

export const commandId = (playerId: PlayerId, tick: number, sequence: number): string => `${playerId}:${tick}:${sequence}`;
