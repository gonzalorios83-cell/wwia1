import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Shared lobby metadata. `stateJson` keeps the V1 room shape replaceable while
 * the simulation protocol is still being prepared for a later server-authoritative step. */
export const multiplayerRooms = sqliteTable("multiplayer_rooms", {
  roomId: text("room_id").primaryKey(),
  hostId: text("host_id").notNull(),
  maxPlayers: integer("max_players").notNull().default(2),
  status: text("status").notNull().default("waiting"),
  stateJson: text("state_json").notNull(),
  snapshotJson: text("snapshot_json"),
  updatedAt: integer("updated_at").notNull(),
});

/** Per-player event queue used by the HTTP polling transport. */
export const multiplayerEvents = sqliteTable("multiplayer_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  targetPlayerId: text("target_player_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
