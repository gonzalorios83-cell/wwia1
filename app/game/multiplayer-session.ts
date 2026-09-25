import type { MatchCommand } from "./commands";
import type { PlayerId, PlayerMarker, PlayerProfile, TeamId } from "./types";

export const MULTIPLAYER_MAX_PLAYERS = 4;

export type MultiplayerRoomPlayer = PlayerProfile & {
  displayName: string;
  connected: boolean;
  joinedAt: number;
};

export type MultiplayerRoomState = {
  roomId: string;
  hostId: PlayerId;
  maxPlayers: number;
  players: MultiplayerRoomPlayer[];
  status: "waiting" | "running";
  gameSpeed: 1 | 1.5 | 2;
};

export type MultiplayerSetup = {
  scenario: string;
  sector: string;
  resources: string;
  difficulty: string;
  /** Two commanders opposing each other, or a shared front against the AI. */
  matchMode: "versus" | "allies";
  /** Only applies to allied matches.  When on, allied commanders may attack. */
  friendlyFire: boolean;
};

/**
 * Compact live state sent frequently while a match is running.  The complete
 * snapshot remains the recovery path; this frame keeps remote movement fluid
 * without repeatedly shipping the whole saved game.
 */
export type MultiplayerStateFrame = {
  simulationTick: number;
  gameTime: number;
  units: Array<{ id: number; x: number; y: number; hp: number; angle: number; moveSpeed: number }>;
};

export type MultiplayerClientMessage =
  | { type: "join"; roomId: string; player: { playerId: PlayerId; displayName: string; teamId: TeamId; marker: PlayerMarker }; maxPlayers: number }
  | { type: "command"; command: MatchCommand }
  | { type: "snapshot"; snapshot: unknown }
  | { type: "state_frame"; frame: MultiplayerStateFrame }
  | { type: "game_speed"; speed: 1 | 1.5 | 2 }
  | { type: "match_start"; setup: MultiplayerSetup };

export type MultiplayerServerMessage =
  | { type: "room_state"; state: MultiplayerRoomState }
  | { type: "peer_command"; sourcePlayerId: PlayerId; command: MatchCommand }
  | { type: "snapshot"; snapshot: unknown }
  | { type: "state_frame"; frame: MultiplayerStateFrame }
  | { type: "game_speed"; speed: 1 | 1.5 | 2 }
  | { type: "match_start"; hostId: PlayerId; setup: MultiplayerSetup }
  | { type: "error"; message: string };

const ROOM_PATTERN = /^[A-Z0-9]{4,8}$/;

export const normalizeRoomId = (value: string): string => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

export const isValidRoomId = (value: string): boolean => ROOM_PATTERN.test(normalizeRoomId(value));

export const createRoomId = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let roomId = "";
  for (let index = 0; index < 6; index += 1) roomId += alphabet[Math.floor(Math.random() * alphabet.length)];
  return roomId;
};

export const createClientPlayerId = (): PlayerId => `player-${Math.random().toString(36).slice(2, 10)}`;
