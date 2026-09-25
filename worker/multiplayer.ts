type Player = {
  playerId: string;
  displayName: string;
  teamId: string;
  marker: { color: string; symbol: string };
  connected: boolean;
  joinedAt: number;
};

type RoomState = {
  roomId: string;
  hostId: string;
  maxPlayers: number;
  players: Player[];
  status: "waiting" | "running";
};

type RoomRow = {
  room_id: string;
  host_id: string;
  max_players: number;
  status: string;
  state_json: string;
  snapshot_json: string | null;
};

const roomIdPattern = /^[A-Z0-9]{4,8}$/;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
});

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

const readRoomState = (row: RoomRow): RoomState => {
  try {
    const parsed = JSON.parse(row.state_json) as Partial<RoomState>;
    const players = Array.isArray(parsed.players) ? parsed.players : [];
    return {
      roomId: row.room_id,
      hostId: row.host_id,
      maxPlayers: row.max_players,
      status: row.status === "running" ? "running" : "waiting",
      players: players.filter(isObject).map(player => ({
        playerId: String(player.playerId || ""),
        displayName: String(player.displayName || "Jugador"),
        teamId: String(player.teamId || "team-human"),
        marker: isObject(player.marker) ? {
          color: String(player.marker.color || "#55bdf2"),
          symbol: String(player.marker.symbol || "●"),
        } : { color: "#55bdf2", symbol: "●" },
        connected: player.connected !== false,
        joinedAt: Number(player.joinedAt) || Date.now(),
      })).filter(player => player.playerId),
    };
  } catch {
    return {
      roomId: row.room_id,
      hostId: row.host_id,
      maxPlayers: row.max_players,
      status: row.status === "running" ? "running" : "waiting",
      players: [],
    };
  }
};

const parsePlayer = (value: unknown): Player | null => {
  if (!isObject(value) || typeof value.playerId !== "string" || !value.playerId.trim()) return null;
  const marker = isObject(value.marker) ? value.marker : {};
  return {
    playerId: value.playerId.trim().slice(0, 80),
    displayName: String(value.displayName || "Jugador").trim().slice(0, 32) || "Jugador",
    teamId: String(value.teamId || "team-human").slice(0, 80),
    marker: {
      color: String(marker.color || "#55bdf2").slice(0, 24),
      symbol: String(marker.symbol || "●").slice(0, 4),
    },
    connected: true,
    joinedAt: Date.now(),
  };
};

const roomFromDb = async (db: D1Database, roomId: string): Promise<{ row: RoomRow; state: RoomState } | null> => {
  const row = await db.prepare("SELECT room_id, host_id, max_players, status, state_json, snapshot_json FROM multiplayer_rooms WHERE room_id = ?1").bind(roomId).first<RoomRow>();
  return row ? { row, state: readRoomState(row) } : null;
};

const saveRoom = async (db: D1Database, state: RoomState, snapshotJson: string | null = null): Promise<void> => {
  await db.prepare(`
    INSERT INTO multiplayer_rooms (room_id, host_id, max_players, status, state_json, snapshot_json, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(room_id) DO UPDATE SET
      host_id = excluded.host_id,
      max_players = excluded.max_players,
      status = excluded.status,
      state_json = excluded.state_json,
      snapshot_json = COALESCE(excluded.snapshot_json, multiplayer_rooms.snapshot_json),
      updated_at = excluded.updated_at
  `).bind(state.roomId, state.hostId, state.maxPlayers, state.status, JSON.stringify(state), snapshotJson, Date.now()).run();
};

const readEvents = async (db: D1Database, roomId: string, playerId: string): Promise<unknown[]> => {
  const rows = await db.prepare("SELECT id, payload_json FROM multiplayer_events WHERE room_id = ?1 AND target_player_id = ?2 ORDER BY id ASC LIMIT 50").bind(roomId, playerId).all<{ id: number; payload_json: string }>();
  if (!rows.results.length) return [];
  const statements = rows.results.map(row => db.prepare("DELETE FROM multiplayer_events WHERE id = ?1").bind(row.id));
  await db.batch(statements);
  return rows.results.flatMap(row => {
    try { return [JSON.parse(row.payload_json)]; } catch { return []; }
  });
};

export const handleMultiplayerRequest = async (request: Request, db: D1Database): Promise<Response> => {
  if (!db) return json({ message: "La sala no está disponible en este momento." }, 503);

  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const roomId = (url.searchParams.get("room") || "").toUpperCase();
      const playerId = url.searchParams.get("player") || "";
      if (!roomIdPattern.test(roomId) || !playerId) return json({ message: "Sala no encontrada." }, 404);
      const room = await roomFromDb(db, roomId);
      if (!room || !room.state.players.some(player => player.playerId === playerId)) return json({ message: "Sala no encontrada." }, 404);
      const events = await readEvents(db, roomId, playerId);
      let snapshot: unknown;
      if (room.row.snapshot_json) {
        try { snapshot = JSON.parse(room.row.snapshot_json); } catch { snapshot = undefined; }
      }
      return json({ state: room.state, events, snapshot });
    }

    if (request.method !== "POST") return json({ message: "Método no permitido." }, 405);
    const message = await request.json().catch(() => null) as Record<string, any> | null;
    if (!message) return json({ message: "Mensaje inválido." }, 400);

    if (message.type === "join") {
      const roomId = typeof message.roomId === "string" ? message.roomId.toUpperCase() : "";
      const player = parsePlayer(message.player);
      if (!roomIdPattern.test(roomId) || !player) return json({ message: "Código de sala inválido." }, 400);

      const requestedMax = Number(message.maxPlayers);
      const existing = await roomFromDb(db, roomId);
      const state: RoomState = existing?.state || {
        roomId,
        hostId: player.playerId,
        maxPlayers: requestedMax >= 2 && requestedMax <= 4 ? requestedMax : 2,
        players: [],
        status: "waiting",
      };
      const current = state.players.find(item => item.playerId === player.playerId);
      if (!current && state.players.length >= state.maxPlayers) return json({ message: "La sala está completa." }, 409);
      player.joinedAt = current?.joinedAt || player.joinedAt;
      state.players = current ? state.players.map(item => item.playerId === player.playerId ? player : item) : [...state.players, player];
      await saveRoom(db, state, existing?.row.snapshot_json || null);
      return json({ state, events: [] });
    }

    const roomId = typeof message.roomId === "string" ? message.roomId.toUpperCase() : "";
    const playerId = String(message.playerId || message.command?.playerId || "");
    const existing = roomIdPattern.test(roomId) ? await roomFromDb(db, roomId) : null;
    if (!existing || !existing.state.players.some(player => player.playerId === playerId)) return json({ message: "Sala no encontrada." }, 404);

    if (message.type === "snapshot") {
      if (playerId !== existing.state.hostId) return json({ message: "Sólo el anfitrión puede actualizar la simulación." }, 403);
      const snapshotJson = JSON.stringify(message.snapshot);
      if (!message.snapshot || snapshotJson.length > 450_000) return json({ message: "Snapshot de partida inválido." }, 400);
      await db.prepare("UPDATE multiplayer_rooms SET snapshot_json = ?1, updated_at = ?2 WHERE room_id = ?3").bind(snapshotJson, Date.now(), roomId).run();
      return json({ state: existing.state, events: [] });
    }

    if (message.type === "command" && message.command) {
      const peers = existing.state.players.filter(player => player.playerId !== playerId);
      if (peers.length) await db.batch(peers.map(peer => db.prepare("INSERT INTO multiplayer_events (room_id, target_player_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)").bind(roomId, peer.playerId, JSON.stringify({ type: "peer_command", sourcePlayerId: playerId, command: message.command }), Date.now())));
      return json({ state: existing.state, events: [] });
    }

    if (message.type === "match_start" && playerId === existing.state.hostId) {
      const state = { ...existing.state, status: "running" as const };
      await saveRoom(db, state, existing.row.snapshot_json);
      const peers = state.players.filter(player => player.playerId !== playerId);
      if (peers.length) await db.batch(peers.map(peer => db.prepare("INSERT INTO multiplayer_events (room_id, target_player_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)").bind(roomId, peer.playerId, JSON.stringify({ type: "match_start", hostId: state.hostId, setup: message.setup || {} }), Date.now())));
      return json({ state, events: [] });
    }

    return json({ message: "Mensaje no reconocido." }, 400);
  } catch (error) {
    console.error("multiplayer request failed", error);
    return json({ message: "No se pudo actualizar la sala." }, 500);
  }
};
