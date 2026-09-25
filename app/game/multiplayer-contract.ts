/**
 * Multiplayer-ready primitives.
 *
 * This module deliberately contains no React, canvas, timers or browser APIs.
 * It is the public compatibility boundary for a future authoritative match
 * service.  Domain types and serializable commands live in smaller modules so
 * the current single-player page can migrate incrementally.
 */

import type { Faction, MatchPoint, PlayerId, PlayerProfile, TeamId } from "./types";
import type { MatchCommand } from "./commands";
import { isMatchCommand as isSerializableMatchCommand } from "./commands";

export type { Faction, MatchPoint, OwnerId, Ownership, PlayerId, PlayerProfile, Point, TeamId } from "./types";
export type {
  AttackCommand,
  BuildCommand,
  CancelCommand,
  CaptureCommand,
  CommandDraft,
  CommandBase,
  MatchCommand,
  MoveCommand,
  ProduceCommand,
} from "./commands";

export const MULTIPLAYER_SCHEMA_VERSION = 1 as const;

export type GameSide = Faction;

export type PlayerMarker = {
  color: string;
  symbol: string;
};

export type LegacyPlayerProfile = {
  id: PlayerId;
  teamId: TeamId;
  faction: GameSide;
  marker: PlayerMarker;
};

/** Legacy aliases kept for any future caller that imported the first P0 contract. */
export type QueueProductionCommand = import("./commands").ProduceCommand;
export type StopCommand = import("./commands").CancelCommand;

export type MatchSnapshot<State = unknown> = {
  schemaVersion: typeof MULTIPLAYER_SCHEMA_VERSION;
  matchId: string;
  tick: number;
  gameTime: number;
  players: PlayerProfile[];
  state: State;
};

export const PLAYER_MARKERS: Record<GameSide, PlayerMarker> = {
  human: { color: "#55bdf2", symbol: "●" },
  machine: { color: "#e15a56", symbol: "◆" },
};

export const markerForSide = (side: GameSide): PlayerMarker => PLAYER_MARKERS[side];

export const createSnapshot = <State>(input: Omit<MatchSnapshot<State>, "schemaVersion">): MatchSnapshot<State> => ({
  schemaVersion: MULTIPLAYER_SCHEMA_VERSION,
  ...input,
});

export const isMatchCommand = (value: unknown): value is MatchCommand => {
  return isSerializableMatchCommand(value);
};
