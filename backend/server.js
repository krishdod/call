import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomUUID } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

/** @type {Map<string, string>} userId -> socketId */
const userIdToSocket = new Map();
const userLogs = new Map();

function normalizeId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 24);
}

function pushLog(userId, entry) {
  const existing = userLogs.get(userId) ?? [];
  existing.push({
    id: randomUUID(),
    ...entry,
    at: new Date().toISOString()
  });
  userLogs.set(userId, existing.slice(-200));
}

function onlineUsers() {
  const users = [];
  for (const [userId, socketId] of userIdToSocket.entries()) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      users.push({
        userId,
        displayName: socket.data.displayName
      });
    }
  }
  return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function broadcastOnlineUsers() {
  io.emit("online-users", onlineUsers());
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/logs/:userId", (req, res) => {
  const key = normalizeId(req.params.userId);
  res.json(userLogs.get(key) ?? []);
});

io.on("connection", (socket) => {
  socket.on("register", ({ userId, displayName, shareUserId = false }) => {
    const normalizedId = normalizeId(userId);
    if (!normalizedId || normalizedId.length < 3) {
      socket.emit("register-failed", { reason: "invalid" });
      return;
    }
    const name = (displayName || "").trim() || normalizedId;
    socket.data.userId = normalizedId;
    socket.data.displayName = name;
    socket.data.shareUserId = Boolean(shareUserId);
    userIdToSocket.set(normalizedId, socket.id);
    socket.emit("registered", { userId: normalizedId, displayName: name });
    broadcastOnlineUsers();
  });

  socket.on("start-call", ({ targetUserId }) => {
    const target = normalizeId(targetUserId);
    const self = socket.data.userId;
    if (!self || !target) {
      socket.emit("start-call-failed", { reason: "invalid" });
      return;
    }
    if (target === self) {
      socket.emit("start-call-failed", { reason: "self" });
      return;
    }
    const targetSocketId = userIdToSocket.get(target);
    if (!targetSocketId) {
      socket.emit("start-call-failed", { reason: "offline" });
      return;
    }

    pushLog(self, { type: "outgoing", to: target });
    pushLog(target, { type: "incoming_ring", from: self });

    io.to(targetSocketId).emit("incoming-call", {
      fromUserId: self,
      fromName: socket.data.displayName,
      callerLabel: socket.data.shareUserId
        ? `${socket.data.displayName} (@${self})`
        : socket.data.displayName,
      fromSocketId: socket.id
    });
    socket.emit("call-ringing", { targetSocketId, targetUserId: target });
  });

  socket.on("accept-call", ({ callerSocketId }) => {
    if (!callerSocketId) return;
    const callee = socket.data.userId;
    const caller = io.sockets.sockets.get(callerSocketId)?.data?.userId;
    if (callee && caller) {
      pushLog(callee, { type: "answered", from: caller });
      pushLog(caller, { type: "answered_by", to: callee });
    }
    io.to(callerSocketId).emit("remote-answered", { calleeSocketId: socket.id });
  });

  socket.on("reject-call", ({ callerSocketId }) => {
    if (!callerSocketId) return;
    const caller = io.sockets.sockets.get(callerSocketId)?.data?.userId;
    const callee = socket.data.userId;
    if (caller && callee) {
      pushLog(callee, { type: "rejected", from: caller });
      pushLog(caller, { type: "rejected_by", to: callee });
    }
    io.to(callerSocketId).emit("call-rejected", { reason: "declined" });
  });

  socket.on("cancel-outgoing", ({ targetSocketId }) => {
    if (!targetSocketId) return;
    io.to(targetSocketId).emit("incoming-cancelled", { fromSocketId: socket.id });
  });

  socket.on("webrtc-offer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-offer", {
      from: socket.id,
      fromName: socket.data.displayName,
      fromNumber: socket.data.phoneNumber,
      sdp
    });
  });

  socket.on("webrtc-answer", ({ to, sdp }) => {
    io.to(to).emit("webrtc-answer", {
      from: socket.id,
      sdp
    });
  });

  socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("webrtc-ice-candidate", {
      from: socket.id,
      candidate
    });
  });

  socket.on("call-ended", ({ to }) => {
    const self = socket.data.userId;
    const other = io.sockets.sockets.get(to)?.data?.userId;
    if (self && other) {
      pushLog(self, { type: "end", with: other });
      pushLog(other, { type: "end", with: self });
    }
    io.to(to).emit("call-ended", { from: socket.id });
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    if (userId && userIdToSocket.get(userId) === socket.id) {
      userIdToSocket.delete(userId);
      broadcastOnlineUsers();
    }
  });
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => {
  console.log(`Signaling server running on http://localhost:${port}`);
});
