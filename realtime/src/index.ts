import { DurableObject } from "cloudflare:workers";

type Marker = { color: string; symbol: string };
type Player = { playerId: string; displayName: string; teamId: string; marker: Marker; connected: boolean; joinedAt: number };
type RoomState = { roomId: string; hostId: string; maxPlayers: number; players: Player[]; status: "waiting" | "running"; gameSpeed: 1 | 1.5 | 2 };
type SocketAttachment = { playerId: string };

export interface Env { ROOM: DurableObjectNamespace; }

const ROOM_ID = /^[A-Z0-9]{4,8}$/;
const PLAYER_ID = /^[a-zA-Z0-9_-]{3,80}$/;

const response = (message: string, status = 400) => new Response(message, { status, headers: { "cache-control": "no-store" } });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";
const send = (socket: WebSocket, payload: unknown) => socket.send(JSON.stringify(payload));

/**
 * One Durable Object is the authoritative coordinator for one room. It does
 * not yet simulate WWIA itself: it validates room membership, relays player
 * commands to the host, and fan-outs the host snapshot to the other clients.
 * This keeps the live wire boundary ready for moving the simulation server-side
 * without coupling room networking to the React game screen.
 */
export class WwiaRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); }

  private async state(): Promise<RoomState | null> { return (await this.ctx.storage.get<RoomState>("room")) ?? null; }
  private sockets(): WebSocket[] { return this.ctx.getWebSockets(); }
  private attachment(socket: WebSocket): SocketAttachment | null { return socket.deserializeAttachment() as SocketAttachment | null; }
  private broadcast(payload: unknown, exceptPlayerId?: string): void {
    for (const socket of this.sockets()) {
      const playerId = this.attachment(socket)?.playerId;
      if (!playerId || playerId === exceptPlayerId) continue;
      try { send(socket, payload); } catch { socket.close(1011, "No se pudo entregar el mensaje."); }
    }
  }
  private sendTo(playerId: string, payload: unknown): void {
    for (const socket of this.sockets()) if (this.attachment(socket)?.playerId === playerId) {
      try { send(socket, payload); } catch { socket.close(1011, "No se pudo entregar el mensaje."); }
    }
  }
  private async publishRoom(): Promise<void> {
    const state = await this.state();
    if (state) this.broadcast({ type: "room_state", state });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return response("Se requiere WebSocket.", 426);
    const url = new URL(request.url);
    const roomId = (url.searchParams.get("room") || "").toUpperCase();
    if (!ROOM_ID.test(roomId)) return response("Código de sala inválido.");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ playerId: "" } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== "string" || rawMessage.length > 480_000) { send(socket, { type: "error", message: "Mensaje de sala inválido." }); return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(rawMessage) as Record<string, unknown>; } catch { send(socket, { type: "error", message: "Mensaje de sala inválido." }); return; }
    const currentAttachment = this.attachment(socket);

    if (message.type === "join") {
      const roomId = typeof message.roomId === "string" ? message.roomId.toUpperCase() : "";
      const incoming = isRecord(message.player) ? message.player : null;
      if (!ROOM_ID.test(roomId) || !incoming || typeof incoming.playerId !== "string" || !PLAYER_ID.test(incoming.playerId)) { send(socket, { type: "error", message: "Datos de sala inválidos." }); return; }
      const marker = isRecord(incoming.marker) ? incoming.marker : {};
      const player: Player = {
        playerId: incoming.playerId,
        displayName: String(incoming.displayName || "Jugador").trim().slice(0, 32) || "Jugador",
        teamId: String(incoming.teamId || `team-${incoming.playerId}`).slice(0, 80),
        marker: { color: String(marker.color || "#55bdf2").slice(0, 24), symbol: String(marker.symbol || "●").slice(0, 4) },
        connected: true,
        joinedAt: Date.now(),
      };
      const existing = await this.state();
      const requestedMax = Number(message.maxPlayers);
      const state: RoomState = existing ?? { roomId, hostId: player.playerId, maxPlayers: requestedMax >= 2 && requestedMax <= 4 ? requestedMax : 2, players: [], status: "waiting", gameSpeed: 1 };
      if (state.roomId !== roomId) { send(socket, { type: "error", message: "Sala inválida." }); return; }
      if (state.gameSpeed !== 1 && state.gameSpeed !== 1.5 && state.gameSpeed !== 2) state.gameSpeed = 1;
      const known = state.players.find(item => item.playerId === player.playerId);
      if (!known && state.players.length >= state.maxPlayers) { send(socket, { type: "error", message: "La sala está completa." }); return; }
      player.joinedAt = known?.joinedAt || player.joinedAt;
      state.players = known ? state.players.map(item => item.playerId === player.playerId ? player : item) : [...state.players, player];
      socket.serializeAttachment({ playerId: player.playerId } satisfies SocketAttachment);
      await this.ctx.storage.put("room", state);
      const snapshot = await this.ctx.storage.get<unknown>("snapshot");
      send(socket, { type: "room_state", state });
      if (snapshot && state.status === "running") send(socket, { type: "snapshot", snapshot });
      await this.publishRoom();
      return;
    }

    const playerId = currentAttachment?.playerId;
    const state = await this.state();
    if (!playerId || !state || !state.players.some(player => player.playerId === playerId)) { send(socket, { type: "error", message: "Unite a una sala primero." }); return; }

    if (message.type === "command" && isRecord(message.command)) {
      const command = message.command;
      if (command.playerId !== playerId || typeof command.commandId !== "string" || !Number.isInteger(command.tick)) { send(socket, { type: "error", message: "Orden inválida." }); return; }
      this.sendTo(state.hostId, { type: "peer_command", sourcePlayerId: playerId, command });
      return;
    }
    if (message.type === "state_frame") {
      if (playerId !== state.hostId || !isRecord(message.frame) || !Array.isArray(message.frame.units)) { send(socket, { type: "error", message: "Actualización de partida inválida." }); return; }
      const frame = message.frame;
      if (!Number.isInteger(frame.simulationTick) || typeof frame.gameTime !== "number" || frame.units.length > 600) { send(socket, { type: "error", message: "Actualización de partida inválida." }); return; }
      this.broadcast({ type: "state_frame", frame }, playerId);
      return;
    }
    if (message.type === "game_speed") {
      const speed = message.speed;
      if (playerId !== state.hostId || (speed !== 1 && speed !== 1.5 && speed !== 2)) { send(socket, { type: "error", message: "Sólo el anfitrión puede cambiar la velocidad." }); return; }
      state.gameSpeed = speed;
      await this.ctx.storage.put("room", state);
      this.sendTo(state.hostId, { type: "game_speed", speed });
      this.broadcast({ type: "game_speed", speed }, state.hostId);
      return;
    }
    if (message.type === "snapshot") {
      if (playerId !== state.hostId || !message.snapshot) { send(socket, { type: "error", message: "Sólo el anfitrión actualiza la partida." }); return; }
      await this.ctx.storage.put("snapshot", message.snapshot);
      this.broadcast({ type: "snapshot", snapshot: message.snapshot }, playerId);
      return;
    }
    if (message.type === "match_start") {
      if (playerId !== state.hostId || state.players.length < 2) { send(socket, { type: "error", message: "Sólo el anfitrión puede iniciar cuando haya dos jugadores." }); return; }
      state.status = "running";
      await this.ctx.storage.put("room", state);
      const matchStart = { type: "match_start", hostId: state.hostId, setup: message.setup || {} };
      this.sendTo(state.hostId, matchStart);
      this.broadcast(matchStart, state.hostId);
      await this.publishRoom();
      return;
    }
    send(socket, { type: "error", message: "Mensaje no reconocido." });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const playerId = this.attachment(socket)?.playerId;
    socket.close();
    if (!playerId) return;
    const state = await this.state();
    if (!state) return;
    const otherLiveSocket = this.sockets().some(peer => peer !== socket && this.attachment(peer)?.playerId === playerId);
    if (otherLiveSocket) return;
    const player = state.players.find(item => item.playerId === playerId);
    if (!player) return;
    player.connected = false;
    await this.ctx.storage.put("room", state);
    await this.publishRoom();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return response("No encontrado.", 404);
    const roomId = (url.searchParams.get("room") || "").toUpperCase();
    if (!ROOM_ID.test(roomId)) return response("Código de sala inválido.");
    return env.ROOM.get(env.ROOM.idFromName(roomId)).fetch(request);
  },
};
