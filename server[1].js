import express from "express";
import http from "http";
import { Server } from "socket.io";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "users.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}
const users = loadUsers();
const sessions = new Map();
const online = new Map();
const friendRequests = new Map();
const matches = new Map();

function cleanName(name) {
  return String(name || "").trim().slice(0, 16);
}
function validPassword(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 64;
}
function publicUser(name) {
  const u = users[name];
  if (!u) return null;
  return {
    username: name,
    level: u.level,
    xp: u.xp,
    coins: u.coins,
    wins: u.wins,
    losses: u.losses,
    friends: u.friends
  };
}

app.post("/api/register", async (req, res) => {
  const username = cleanName(req.body.username);
  const password = req.body.password;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username))
    return res.status(400).json({error:"Benutzername: 3–16 Zeichen, nur Buchstaben, Zahlen und _."});
  if (!validPassword(password))
    return res.status(400).json({error:"Passwort muss 4–64 Zeichen haben."});
  if (users[username]) return res.status(409).json({error:"Dieser Benutzername ist schon vergeben."});

  users[username] = {
    passwordHash: await bcrypt.hash(password, 12),
    level: 1, xp: 0, coins: 500, wins: 0, losses: 0, friends: []
  };
  saveUsers(users);
  const token = crypto.randomUUID();
  sessions.set(token, username);
  res.json({token, user: publicUser(username)});
});

app.post("/api/login", async (req, res) => {
  const username = cleanName(req.body.username);
  const password = req.body.password;
  const u = users[username];
  if (!u || !(await bcrypt.compare(password, u.passwordHash)))
    return res.status(401).json({error:"Benutzername oder Passwort falsch."});

  const token = crypto.randomUUID();
  sessions.set(token, username);
  res.json({token, user: publicUser(username)});
});

function auth(req) {
  const token = String(req.headers.authorization || "").replace("Bearer ", "");
  return sessions.get(token);
}

app.get("/api/me", (req, res) => {
  const username = auth(req);
  if (!username) return res.status(401).json({error:"Nicht angemeldet."});
  res.json({user: publicUser(username)});
});

app.get("/api/search", (req, res) => {
  const q = cleanName(req.query.q).toLowerCase();
  const results = Object.keys(users)
    .filter(n => n.toLowerCase().includes(q))
    .slice(0, 20)
    .map(publicUser);
  res.json({results});
});

app.post("/api/friend-request", (req, res) => {
  const from = auth(req);
  const to = cleanName(req.body.to);
  if (!from) return res.status(401).json({error:"Nicht angemeldet."});
  if (!users[to]) return res.status(404).json({error:"Spieler nicht gefunden."});
  if (from === to) return res.status(400).json({error:"Du kannst dich nicht selbst hinzufügen."});
  users[to].requests ||= [];
  if (!users[to].requests.includes(from) && !users[to].friends.includes(from))
    users[to].requests.push(from);
  saveUsers(users);
  const socketId = online.get(to);
  if (socketId) io.to(socketId).emit("friendRequest", {from});
  res.json({ok:true});
});

app.get("/api/friends", (req, res) => {
  const me = auth(req);
  if (!me) return res.status(401).json({error:"Nicht angemeldet."});
  const u = users[me];
  res.json({
    friends: u.friends.map(publicUser),
    requests: (u.requests || []).map(n => publicUser(n))
  });
});

app.post("/api/friend-accept", (req, res) => {
  const me = auth(req), other = cleanName(req.body.from);
  if (!me || !users[other]) return res.status(400).json({error:"Ungültige Anfrage."});
  users[me].requests = (users[me].requests || []).filter(n => n !== other);
  if (!users[me].friends.includes(other)) users[me].friends.push(other);
  if (!users[other].friends.includes(me)) users[other].friends.push(me);
  saveUsers(users);
  res.json({ok:true});
});

io.on("connection", socket => {
  socket.on("online", token => {
    const username = sessions.get(token);
    if (!username) return;
    socket.data.username = username;
    online.set(username, socket.id);
    io.emit("presence", {username, online:true});
  });

  socket.on("queue", () => {
    const username = socket.data.username;
    if (!username) return;
    const waiting = [...io.sockets.sockets.values()]
      .find(s => s !== socket && s.data.username && s.data.queueing && !s.data.inMatch);
    if (waiting) {
      socket.data.queueing = false;
      waiting.data.queueing = false;
      const matchId = crypto.randomUUID();
      matches.set(matchId, {players:[username, waiting.data.username]});
      socket.data.inMatch = waiting.data.inMatch = matchId;
      socket.emit("matchFound", {matchId, opponent: waiting.data.username});
      waiting.emit("matchFound", {matchId, opponent: username});
    } else {
      socket.data.queueing = true;
      socket.emit("queued");
    }
  });

  socket.on("battleInput", data => {
    const username = socket.data.username;
    const matchId = socket.data.inMatch;
    if (!username || !matchId) return;
    const m = matches.get(matchId);
    if (!m) return;
    const other = m.players.find(n => n !== username);
    const otherSocket = online.get(other);
    if (otherSocket) io.to(otherSocket).emit("opponentInput", {
      username, input: data
    });
  });

  socket.on("disconnect", () => {
    const username = socket.data.username;
    if (username) {
      online.delete(username);
      io.emit("presence", {username, online:false});
    }
  });
});

server.listen(PORT, () => console.log(`Battle Rush Online läuft auf http://localhost:${PORT}`));
