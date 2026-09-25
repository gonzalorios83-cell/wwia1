/**
 * Shared identity and ownership types for a future multiplayer match.
 *
 * These types are intentionally independent from React, canvas and browser
 * APIs.  The current game still uses `faction` as its local human/machine
 * compatibility field, while `ownerId` and `teamId` provide the stable
 * multiplayer boundary.
 */

export type PlayerId = string;
export type TeamId = string;
export type OwnerId = PlayerId;
export type Faction = "human" | "machine";
export type PlayerMarker = { color: string; symbol: string };

export type Point = { x: number; y: number };
export type MatchPoint = Point;

export type Ownership = {
  ownerId: OwnerId;
  teamId: TeamId;
  faction: Faction;
};

export type PlayerProfile = Ownership & {
  playerId: PlayerId;
  marker: { color: string; symbol: string };
};

export const DEFAULT_PLAYER_IDS: Record<Faction, PlayerId> = {
  human: "player-1",
  machine: "player-2",
};

export const DEFAULT_TEAM_IDS: Record<Faction, TeamId> = {
  human: "team-human",
  machine: "team-machine",
};

export const ownershipForFaction = (faction: Faction): Ownership => ({
  ownerId: DEFAULT_PLAYER_IDS[faction],
  teamId: DEFAULT_TEAM_IDS[faction],
  faction,
});

/**
 * Migrates an entity created before the multiplayer identity fields existed.
 * Keeping this adapter permissive lets existing local save slots continue to
 * load while new entities receive complete ownership metadata immediately.
 */
export const ensureOwnership = <T extends { side?: Faction; faction?: Faction; ownerId?: OwnerId; teamId?: TeamId }>(
  entity: T,
  fallbackFaction: Faction,
): T & Ownership => {
  const faction = entity.faction ?? entity.side ?? fallbackFaction;
  const ownership = ownershipForFaction(faction);
  return {
    ...entity,
    ownerId: entity.ownerId ?? ownership.ownerId,
    teamId: entity.teamId ?? ownership.teamId,
    faction,
  };
};

export const DEFAULT_PLAYERS: PlayerProfile[] = (Object.keys(DEFAULT_PLAYER_IDS) as Faction[]).map((faction) => {
  const ownership = ownershipForFaction(faction);
  return {
    playerId: ownership.ownerId,
    ...ownership,
    marker: faction === "human" ? { color: "#55bdf2", symbol: "●" } : { color: "#e15a56", symbol: "◆" },
  };
});
