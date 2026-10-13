/*
 * server.js — RE21 联机服务器
 *  - 提供 public/ 下的静态网页
 *  - WebSocket 房间系统：创建/加入房间（4 位码）、服务端权威同步、聊天
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const RE21 = require("./engine.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- 静态服务 ----------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // 引擎同时被浏览器加载，从项目根提供（避免与服务器 require 重复）
  if (urlPath === "/engine.js") {
    fs.readFile(path.join(__dirname, "engine.js"), (err, data) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, { "Content-Type": MIME[".js"] });
      res.end(data);
    });
    return;
  }
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- WebSocket 房间 ----------
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { players:[{ws,seat,name}], state, started }

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(c));
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  room.players.forEach((p) => {
    if (!p.ws) return;
    send(p.ws, { type: "state", seat: p.seat, view: RE21.getView(room.state, p.seat) });
  });
}

function opponentOf(room, seat) {
  return room.players.find((p) => p.seat === 1 - seat);
}

function broadcastChat(room, from, text) {
  room.players.forEach((p) => send(p.ws, { type: "chat", from, text }));
}

wss.on("connection", (ws) => {
  ws.seat = null;
  ws.roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create") {
      const code = genCode();
      const room = { players: [], state: null, started: false };
      rooms.set(code, room);
      const seat = 0;
      const name = (msg.name || "玩家1").slice(0, 12);
      room.players.push({ ws, seat, name });
      ws.roomCode = code; ws.seat = seat;
      send(ws, { type: "created", code, seat, name });
      return;
    }

    if (msg.type === "join") {
      const code = (msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: "error", message: "房间不存在" }); return; }
      if (room.started) { send(ws, { type: "error", message: "房间已开始游戏" }); return; }
      if (room.players.length >= 2) { send(ws, { type: "error", message: "房间已满" }); return; }
      const seat = 1;
      const name = (msg.name || "玩家2").slice(0, 12);
      room.players.push({ ws, seat, name });
      ws.roomCode = code; ws.seat = seat;

      // 开局
      const names = [room.players[0].name, room.players[1].name];
      room.state = RE21.createGame({ names });
      RE21.dealRound(room.state);
      room.started = true;
      room.players.forEach((p) =>
        send(p.ws, { type: "start", seat: p.seat, code, you: p.name, opp: opponentOf(room, p.seat).name })
      );
      broadcast(room);
      return;
    }

    // 以下动作需要已在房间内
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room || !room.started) { send(ws, { type: "error", message: "尚未进入房间" }); return; }
    const seat = ws.seat;

    if (msg.type === "action") {
      const r = RE21.applyAction(room.state, seat, msg.action || {});
      if (!r.ok) { send(ws, { type: "error", message: r.error }); return; }
      broadcast(room);
      return;
    }

    if (msg.type === "next") {
      if (room.state.phase === "roundEnd") {
        RE21.dealRound(room.state);
        broadcast(room);
      }
      return;
    }

    if (msg.type === "restart") {
      if (room.state.phase === "gameOver") {
        room.state = RE21.createGame({ names: [room.players[0].name, room.players[1].name] });
        RE21.dealRound(room.state);
        broadcast(room);
      }
      return;
    }

    if (msg.type === "chat") {
      const text = (msg.text || "").slice(0, 200);
      if (text.trim()) broadcastChat(room, room.players[seat].name, text);
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room) return;
    const other = room.players.find((p) => p.ws !== ws);
    if (other) send(other.ws, { type: "opponentLeft" });
    // 若双方都断开，清理房间
    room.players = room.players.filter((p) => p.ws !== ws);
    if (room.players.length === 0) rooms.delete(ws.roomCode);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RE21 服务器已启动: http://localhost:${PORT}`);
});
