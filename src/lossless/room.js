// LosslessRoom — a two-person WebRTC signalling relay.
//
// Each room code maps to one instance of this Durable Object. It holds a
// WebSocket per peer and forwards SDP offers/answers and ICE candidates
// between them. Audio never passes through here; once WebRTC connects, the
// browsers talk directly.
//
// Uses the WebSocket Hibernation API, so an idle room costs nothing while the
// two sockets sit open.

import { DurableObject } from "cloudflare:workers";

const MAX_PEERS = 2;
// Clients ping every 15 s, but browsers throttle timers in background tabs to
// about once a minute, so allow plenty of slack before calling a socket dead.
const STALE_MS = 150_000;
const RELAYED_TYPES = new Set(["offer", "answer", "candidate"]);

export class LosslessRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // Each page load has a stable client id. A device reconnecting after a
    // network blip replaces its own old socket instead of counting against the room.
    const clientId = (new URL(request.url).searchParams.get("client") || "").slice(0, 40) || null;
    let peers = this.livePeers();
    if (clientId) {
      for (const ws of peers) {
        if (ws.deserializeAttachment()?.clientId === clientId) {
          try {
            ws.close(4002, "replaced");
          } catch {
            // already closed
          }
        }
      }
      peers = peers.filter((ws) => ws.deserializeAttachment()?.clientId !== clientId);
    }

    if (peers.length >= MAX_PEERS) {
      // Accept just long enough to tell the browser why, then hang up.
      server.accept();
      server.send(JSON.stringify({ type: "full" }));
      server.close(4000, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, clientId, joined: Date.now() });

    for (const ws of peers) send(ws, { type: "peer-joined", id });
    // The newcomer makes the offer if someone is already here.
    send(server, { type: "welcome", id, peers: peers.length });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 64 * 1024) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!RELAYED_TYPES.has(msg?.type)) return;

    const from = peerId(ws);
    for (const other of this.ctx.getWebSockets()) {
      if (peerId(other) !== from) send(other, { ...msg, from });
    }
  }

  webSocketClose(ws, code) {
    this.leave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {
      // already closed
    }
  }

  webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const { id, clientId } = ws.deserializeAttachment() || {};
    const others = this.ctx.getWebSockets().filter((o) => peerId(o) !== id);
    // Replaced by a newer socket from the same device: it hasn't really left.
    if (clientId && others.some((o) => o.deserializeAttachment()?.clientId === clientId)) return;
    for (const other of others) send(other, { type: "peer-left", id });
  }

  // Open sockets, minus any whose client vanished without closing (e.g. a phone
  // that lost signal). Without this a re-joining device could be locked out by
  // its own ghost.
  livePeers() {
    const now = Date.now();
    return this.ctx.getWebSockets().filter((ws) => {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const lastSeen = lastPing ?? ws.deserializeAttachment()?.joined ?? now;
      if (now - lastSeen <= STALE_MS) return true;
      this.leave(ws);
      try {
        ws.close(4001, "stale");
      } catch {
        // already closed
      }
      return false;
    });
  }
}

function peerId(ws) {
  return ws.deserializeAttachment()?.id;
}

function send(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket is closing; the close handler will clean up
  }
}
