import type { MultiplayerServerMessage, MultiplayerClientMessage } from "./multiplayer-session";

export type MultiplayerTransportStatus = "connecting" | "connected" | "closed" | "error";

type TransportOptions = { onMessage: (message: MultiplayerServerMessage) => void; onStatus: (status: MultiplayerTransportStatus) => void };
const MULTIPLAYER_POLL_INTERVAL_MS = 450;

/** Browser-only HTTP transport kept separate from the simulation and UI.
 * Polling is intentional for the private Sites deployment: it survives the
 * platform's authenticated HTTP edge and keeps the wire contract replaceable
 * by WebSocket/Durable Objects later. */
export class MultiplayerTransport {
  private endpoint = "";
  private activeRoomId = "";
  private activePlayerId = "";
  private pollId: number | undefined;
  private socket: WebSocket | null = null;
  private closed = false;
  private readonly onMessage: TransportOptions["onMessage"];
  private readonly onStatus: TransportOptions["onStatus"];

  constructor(options: TransportOptions) { this.onMessage = options.onMessage; this.onStatus = options.onStatus; }

  connect(url: string): void {
    this.close(); this.endpoint = url; this.closed = false; this.onStatus("connecting");
    if (url.startsWith("ws:" ) || url.startsWith("wss:")) {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => { if (!this.closed && socket === this.socket) this.onStatus("connected"); });
      socket.addEventListener("message", event => {
        try { this.onMessage(JSON.parse(String(event.data)) as MultiplayerServerMessage); } catch { this.onMessage({ type: "error", message: "Mensaje realtime inválido." }); }
      });
      socket.addEventListener("error", () => { if (!this.closed) this.onStatus("error"); });
      socket.addEventListener("close", () => { if (!this.closed) this.onStatus("closed"); });
      return;
    }
    this.onStatus("connected");
  }

  send(message: MultiplayerClientMessage): boolean {
    if (!this.endpoint || this.closed) return false;
    if (message.type === "join") { this.activeRoomId = message.roomId; this.activePlayerId = message.player.playerId; }
    const wireMessage = message.type === "join" ? message : { ...message, roomId: this.activeRoomId, playerId: this.activePlayerId };
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify(wireMessage));
      return true;
    }
    void fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wireMessage) })
      .then(async response => {
        const result = await response.json().catch(() => null) as { state?: unknown; events?: unknown[]; snapshot?: unknown; message?: string } | null;
        if (!response.ok) { this.onMessage({ type: "error", message: result?.message || "No se pudo comunicar con la sala." }); this.onStatus("error"); return; }
        if (result?.state) this.onMessage({ type: "room_state", state: result.state as never });
        if (result?.snapshot) this.onMessage({ type: "snapshot", snapshot: result.snapshot });
        for (const event of result?.events || []) this.onMessage(event as MultiplayerServerMessage);
        if (message.type === "join") this.startPolling(message.roomId, message.player.playerId);
      })
      .catch(() => { this.onStatus("error"); this.onMessage({ type: "error", message: "No se pudo comunicar con la sala." }); });
    return true;
  }

  private startPolling(roomId: string, playerId: string): void {
    if (this.pollId !== undefined) window.clearInterval(this.pollId);
    let requestInFlight = false;
    const poll = () => {
      if (this.closed || requestInFlight) return;
      requestInFlight = true;
      void fetch(`${this.endpoint}?room=${encodeURIComponent(roomId)}&player=${encodeURIComponent(playerId)}`)
        .then(async response => {
          if (!response.ok) return;
          const result = await response.json() as { state?: unknown; events?: unknown[]; snapshot?: unknown };
          if (result.state) this.onMessage({ type: "room_state", state: result.state as never });
          if (result.snapshot) this.onMessage({ type: "snapshot", snapshot: result.snapshot });
          for (const event of result.events || []) this.onMessage(event as MultiplayerServerMessage);
        })
        .catch(() => undefined)
        .finally(() => { requestInFlight = false; });
    };
    poll(); this.pollId = window.setInterval(poll, MULTIPLAYER_POLL_INTERVAL_MS);
  }

  close(): void { this.closed = true; if (this.pollId !== undefined) window.clearInterval(this.pollId); this.pollId = undefined; const socket = this.socket; this.socket = null; if (socket && socket.readyState < WebSocket.CLOSING) socket.close(); this.endpoint = ""; this.activeRoomId = ""; this.activePlayerId = ""; this.onStatus("closed"); }
}
