const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { Readable } = require("stream");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const ADMIN_ID = process.env.ADMIN_ID || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const ADMIN_SESSION_ID = "__system_admin__";
const SEED_DEMO = String(process.env.SEED_DEMO || "false").toLowerCase() === "true";

// ใส่ค่าเริ่มต้นตามลิงก์ที่ผู้ใช้ให้มา แต่ยังสามารถ override ใน Render Environment ได้
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "1aUNaQZy5M5xGKcyMjT4bjHfT5aZxwVMM81bflfb4jFI";
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "1HGh0iEjxu33dokLxCy74EHqmlAm3_37m";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON || "";
const ENABLE_GOOGLE_STORAGE = String(process.env.ENABLE_GOOGLE_STORAGE || "true").toLowerCase() !== "false";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "25mb", type: "*/*" }));

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"]
  }
});

// -----------------------------------------------------------------------------
// PPK Duty Node Backend — V7 weekday duty profile + Google Sheets/Drive
// - Users / Records / Duties / Settings อยู่ใน Google Sheets
// - รูปหลักฐานอยู่ใน Google Drive แล้วเก็บ photoUrl/photoFileId ในชีต
// - Socket.IO ยังใช้ส่งข้อมูลแบบ real-time เหมือนเดิม
// -----------------------------------------------------------------------------

const settings = {
  schoolName: "โรงเรียนพานพิทยาคม",
  openHour: 13,
  openMinute: 30,
  closeHour: 15,
  closeMinute: 30,
  maxUsersPerRoom: 60
};

// แอดมินไม่อยู่ใน users array เพื่อไม่ให้โผล่เป็นนักเรียน
const users = [];
let records = [];
const dutyMap = new Map();
const sessions = new Map();

const defaultDuties = [
  { emoji: "🧹", name: "กวาดพื้น", slots: 2 },
  { emoji: "🪣", name: "ถูพื้น", slots: 2 },
  { emoji: "🗑️", name: "ทิ้งขยะ", slots: 1 },
  { emoji: "🧽", name: "เช็ดกระดาน", slots: 1 },
  { emoji: "🪑", name: "จัดโต๊ะเก้าอี้", slots: 2 }
];

const SHEET_HEADERS = {
  Users: ["userId", "studentId", "password", "name", "grade", "room", "role", "active", "createdAt", "updatedAt", "dutyDay"],
  Records: ["recordId", "dateKey", "grade", "room", "userId", "studentId", "userName", "dutyId", "dutyName", "emoji", "status", "note", "photoUrl", "photoFileId", "captureMode", "captureClientAt", "cameraMetaJson", "selectedAt", "submittedAt", "reviewedAt", "updatedAt", "dutyDay"],
  Duties: ["dutyId", "grade", "room", "emoji", "name", "slots"],
  Settings: ["key", "value"]
};

let sheetsClient = null;
let driveClient = null;
let googleStorageReady = false;
let googleInitError = "";

function id(prefix = "id") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function clean(v = "") {
  return String(v || "").trim();
}

function boolText(value) {
  return value ? "TRUE" : "FALSE";
}

function parseBool(value, defaultValue = true) {
  const s = clean(value).toLowerCase();
  if (!s) return defaultValue;
  return !(s === "false" || s === "0" || s === "no" || s === "inactive");
}

function systemAdmin() {
  return {
    userId: ADMIN_SESSION_ID,
    studentId: ADMIN_ID,
    name: "ผู้ดูแลระบบ",
    grade: "",
    room: "",
    role: "admin",
    active: true
  };
}

function isAdminLogin(loginId) {
  return clean(loginId).toLowerCase() === clean(ADMIN_ID).toLowerCase();
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeDateKey(value) {
  const s = clean(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayKey();
}

const DUTY_DAYS = [
  { key: "mon", label: "วันจันทร์", jsDay: 1 },
  { key: "tue", label: "วันอังคาร", jsDay: 2 },
  { key: "wed", label: "วันพุธ", jsDay: 3 },
  { key: "thu", label: "วันพฤหัสบดี", jsDay: 4 },
  { key: "fri", label: "วันศุกร์", jsDay: 5 }
];

function normalizeDutyDay(value) {
  const s = clean(value).toLowerCase();
  const aliases = {
    monday: "mon", mon: "mon", "จันทร์": "mon", "วันจันทร์": "mon", "1": "mon",
    tuesday: "tue", tue: "tue", "อังคาร": "tue", "วันอังคาร": "tue", "2": "tue",
    wednesday: "wed", wed: "wed", "พุธ": "wed", "วันพุธ": "wed", "3": "wed",
    thursday: "thu", thu: "thu", thur: "thu", "พฤหัส": "thu", "พฤหัสบดี": "thu", "วันพฤหัสบดี": "thu", "4": "thu",
    friday: "fri", fri: "fri", "ศุกร์": "fri", "วันศุกร์": "fri", "5": "fri"
  };
  return aliases[s] || (DUTY_DAYS.some(d => d.key === s) ? s : "");
}

function dutyDayInfo(value) {
  const key = normalizeDutyDay(value);
  return DUTY_DAYS.find(d => d.key === key) || null;
}

function dutyDayLabel(value) {
  const info = dutyDayInfo(value);
  return info ? info.label : "ยังไม่ระบุวันเวร";
}

function weekdayKeyFromDateKey(value) {
  const d = normalizeDateKey(value);
  const [y, m, day] = d.split("-").map(Number);
  const jsDay = new Date(y, (m || 1) - 1, day || 1).getDay();
  const info = DUTY_DAYS.find(item => item.jsDay === jsDay);
  return info ? info.key : "mon";
}

function dateKeyForDutyDay(value, baseDate = new Date()) {
  const info = dutyDayInfo(value) || dutyDayInfo(weekdayKeyFromDateKey(todayKey(baseDate)));
  const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const diff = (info.jsDay - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + diff);
  return todayKey(date);
}

function roomKey(grade, room) {
  return `g${clean(grade)}-r${clean(room)}`;
}

function roomDutyKey(grade, room) {
  return `${clean(grade)}|${clean(room)}`;
}

function publicUser(u) {
  return {
    userId: u.userId,
    studentId: u.studentId,
    name: u.name,
    grade: u.grade,
    room: u.room,
    dutyDay: normalizeDutyDay(u.dutyDay) || weekdayKeyFromDateKey(todayKey()),
    dutyDayLabel: dutyDayLabel(u.dutyDay),
    role: u.role
  };
}

function createToken(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId: user.userId, role: user.role, createdAt: Date.now() });
  return token;
}

function auth(token) {
  const s = sessions.get(clean(token));
  if (!s) return null;
  if (s.userId === ADMIN_SESSION_ID || s.role === "admin") return systemAdmin();
  const u = users.find((item) => item.userId === s.userId && item.active !== false && item.role === "student");
  return u || null;
}

function requireAuth(token) {
  const u = auth(token);
  if (!u) throw new Error("กรุณาเข้าสู่ระบบใหม่");
  return u;
}

function requireAdmin(token) {
  const u = requireAuth(token);
  if (u.role !== "admin") throw new Error("ต้องเป็นผู้ดูแลระบบเท่านั้น");
  return u;
}

function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => obj[h] = row[i] === undefined ? "" : row[i]);
  return obj;
}

function normalizePrivateKey(key) {
  return clean(key).replace(/\\n/g, "\n");
}

function credentialsFromEnv() {
  if (GOOGLE_CREDENTIALS_JSON) {
    try {
      const raw = Buffer.from(GOOGLE_CREDENTIALS_JSON, "base64").toString("utf8");
      const parsed = JSON.parse(raw);
      if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
      return parsed;
    } catch (_) {
      const parsed = JSON.parse(GOOGLE_CREDENTIALS_JSON);
      if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
      return parsed;
    }
  }

  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) return null;
  return {
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: normalizePrivateKey(GOOGLE_PRIVATE_KEY)
  };
}

async function initGoogleClients() {
  if (!ENABLE_GOOGLE_STORAGE) {
    googleInitError = "Google storage disabled by ENABLE_GOOGLE_STORAGE=false";
    return false;
  }

  try {
    const credentials = credentialsFromEnv();
    if (!credentials) {
      googleInitError = "ยังไม่ได้ตั้ง GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY หรือ GOOGLE_CREDENTIALS_JSON ใน Render";
      return false;
    }

    const authClient = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file"
      ]
    });

    sheetsClient = google.sheets({ version: "v4", auth: authClient });
    driveClient = google.drive({ version: "v3", auth: authClient });
    googleStorageReady = true;
    return true;
  } catch (err) {
    googleStorageReady = false;
    googleInitError = err.message || String(err);
    console.error("Google init failed:", googleInitError);
    return false;
  }
}

async function ensureSheetTabs() {
  if (!googleStorageReady) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
  const existing = new Set((meta.data.sheets || []).map(s => s.properties.title));
  const requests = [];
  Object.keys(SHEET_HEADERS).forEach(title => {
    if (!existing.has(title)) requests.push({ addSheet: { properties: { title } } });
  });
  if (requests.length) {
    await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: GOOGLE_SHEET_ID, requestBody: { requests } });
  }

  for (const [title, headers] of Object.entries(SHEET_HEADERS)) {
    const current = await readRange(`${title}!1:1`);
    const firstRow = current[0] || [];
    const needHeader = !firstRow.length || headers.some((h, i) => firstRow[i] !== h);
    if (needHeader) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${title}!1:1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }
  }
}

async function readRange(range) {
  const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });
  return res.data.values || [];
}

async function writeSheet(title, headers, rows) {
  if (!googleStorageReady) return;
  const values = [headers, ...rows];
  await sheetsClient.spreadsheets.values.clear({ spreadsheetId: GOOGLE_SHEET_ID, range: `${title}!A:Z` });
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${title}!A1`,
    valueInputOption: "RAW",
    requestBody: { values }
  });
}

async function loadFromSheets() {
  if (!googleStorageReady) return;

  await ensureSheetTabs();

  users.splice(0, users.length);
  records = [];
  dutyMap.clear();

  const userRows = (await readRange("Users!A2:K")).filter(r => r.some(cell => clean(cell)));
  for (const row of userRows) {
    const o = rowToObject(SHEET_HEADERS.Users, row);
    // กันกรณีมี admin เคยหลุดเข้า sheet เดิม
    if (!o.studentId || isAdminLogin(o.studentId) || clean(o.role) === "admin") continue;
    users.push({
      userId: clean(o.userId) || id("u"),
      studentId: clean(o.studentId).replace(/\D/g, ""),
      password: String(o.password || ""),
      name: clean(o.name),
      grade: clean(o.grade),
      room: clean(o.room),
      role: "student",
      active: parseBool(o.active, true),
      createdAt: clean(o.createdAt),
      updatedAt: clean(o.updatedAt),
      dutyDay: normalizeDutyDay(o.dutyDay) || weekdayKeyFromDateKey(todayKey())
    });
  }

  const recordRows = (await readRange("Records!A2:V")).filter(r => r.some(cell => clean(cell)));
  for (const row of recordRows) {
    const o = rowToObject(SHEET_HEADERS.Records, row);
    if (!o.recordId) continue;
    let cameraMeta = {};
    try { cameraMeta = o.cameraMetaJson ? JSON.parse(o.cameraMetaJson) : {}; } catch (_) {}
    records.push({
      recordId: clean(o.recordId),
      dateKey: normalizeDateKey(o.dateKey),
      grade: clean(o.grade),
      room: clean(o.room),
      userId: clean(o.userId),
      studentId: clean(o.studentId),
      userName: clean(o.userName),
      dutyId: clean(o.dutyId),
      dutyName: clean(o.dutyName),
      emoji: clean(o.emoji) || "📌",
      status: clean(o.status) || "assigned",
      note: clean(o.note),
      photoUrl: clean(o.photoUrl),
      photoFileId: clean(o.photoFileId),
      captureMode: clean(o.captureMode),
      captureClientAt: clean(o.captureClientAt),
      cameraMeta,
      selectedAt: clean(o.selectedAt),
      submittedAt: clean(o.submittedAt),
      reviewedAt: clean(o.reviewedAt),
      updatedAt: clean(o.updatedAt),
      dutyDay: normalizeDutyDay(o.dutyDay) || weekdayKeyFromDateKey(o.dateKey)
    });
  }

  const dutyRows = (await readRange("Duties!A2:F")).filter(r => r.some(cell => clean(cell)));
  for (const row of dutyRows) {
    const o = rowToObject(SHEET_HEADERS.Duties, row);
    const grade = clean(o.grade);
    const room = clean(o.room);
    const name = clean(o.name);
    if (!grade || !room || !name) continue;
    const key = roomDutyKey(grade, room);
    if (!dutyMap.has(key)) dutyMap.set(key, []);
    dutyMap.get(key).push({
      dutyId: clean(o.dutyId) || `d_${grade}_${room}_${dutyMap.get(key).length + 1}`,
      grade,
      room,
      emoji: clean(o.emoji) || "📌",
      name,
      slots: Math.max(1, Math.min(99, Number(o.slots || 1)))
    });
  }

  const settingRows = (await readRange("Settings!A2:B")).filter(r => clean(r[0]));
  for (const row of settingRows) {
    const key = clean(row[0]);
    const value = row[1];
    if (settings[key] === undefined) continue;
    if (["openHour", "openMinute", "closeHour", "closeMinute", "maxUsersPerRoom"].includes(key)) settings[key] = Number(value);
    else settings[key] = clean(value);
  }

  if (SEED_DEMO && !users.some(u => u.studentId === "10001")) {
    users.push(
      { userId: "u_demo_10001", studentId: "10001", password: "1234", name: "นักเรียนทดสอบ 1", grade: "6", room: "1", role: "student", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dutyDay: "mon" },
      { userId: "u_demo_10002", studentId: "10002", password: "1234", name: "นักเรียนทดสอบ 2", grade: "6", room: "1", role: "student", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dutyDay: "mon" }
    );
    await saveUsers();
  }

  console.log(`Loaded from Google Sheets: users=${users.length}, records=${records.length}, dutyRooms=${dutyMap.size}`);
}

async function saveUsers() {
  await writeSheet("Users", SHEET_HEADERS.Users, users
    .filter(u => u.role === "student" && !isAdminLogin(u.studentId))
    .map(u => [u.userId, u.studentId, u.password, u.name, u.grade, u.room, "student", boolText(u.active !== false), u.createdAt || "", u.updatedAt || "", normalizeDutyDay(u.dutyDay) || weekdayKeyFromDateKey(todayKey())]));
}

async function saveRecords() {
  await writeSheet("Records", SHEET_HEADERS.Records, records.map(r => [
    r.recordId, r.dateKey, r.grade, r.room, r.userId, r.studentId, r.userName,
    r.dutyId, r.dutyName, r.emoji, r.status, r.note || "", r.photoUrl || "", r.photoFileId || "",
    r.captureMode || "", r.captureClientAt || "", JSON.stringify(r.cameraMeta || {}),
    r.selectedAt || "", r.submittedAt || "", r.reviewedAt || "", r.updatedAt || "", normalizeDutyDay(r.dutyDay) || weekdayKeyFromDateKey(r.dateKey)
  ]));
}

async function saveDuties() {
  const rows = [];
  dutyMap.forEach((list) => {
    list.forEach(d => rows.push([d.dutyId, d.grade, d.room, d.emoji || "📌", d.name, d.slots || 1]));
  });
  await writeSheet("Duties", SHEET_HEADERS.Duties, rows);
}

async function saveSettings() {
  await writeSheet("Settings", SHEET_HEADERS.Settings, Object.entries(settings).map(([key, value]) => [key, String(value)]));
}

async function persist(kind) {
  if (!googleStorageReady) return;
  if (kind === "users") return saveUsers();
  if (kind === "records") return saveRecords();
  if (kind === "duties") return saveDuties();
  if (kind === "settings") return saveSettings();
  await Promise.all([saveUsers(), saveRecords(), saveDuties(), saveSettings()]);
}

function getDutiesForRoom(grade, room) {
  const key = roomDutyKey(grade, room);
  if (!dutyMap.has(key)) {
    dutyMap.set(key, defaultDuties.map((d, i) => ({
      dutyId: `d_${clean(grade)}_${clean(room)}_${i + 1}`,
      grade: clean(grade),
      room: clean(room),
      emoji: d.emoji,
      name: d.name,
      slots: d.slots
    })));
    // ไม่ await ตรงนี้ เพื่อไม่ให้การอ่านข้อมูลช้า แต่จะบันทึกทันทีถ้าเชื่อม Google พร้อม
    persist("duties").catch(err => console.error("save duties failed:", err.message));
  }
  return dutyMap.get(key);
}

function knownRooms() {
  const map = new Map();
  users.filter((u) => u.active !== false && u.role === "student" && u.grade && u.room).forEach((u) => {
    map.set(roomDutyKey(u.grade, u.room), { grade: u.grade, room: u.room });
  });
  dutyMap.forEach((_, key) => {
    const [grade, room] = key.split("|");
    if (grade && room) map.set(key, { grade, room });
  });
  map.set(roomDutyKey("6", "1"), { grade: "6", room: "1" });
  return Array.from(map.values()).sort((a, b) => `${a.grade}/${a.room}`.localeCompare(`${b.grade}/${b.room}`, "th", { numeric: true }));
}

function getRecords({ dateKey, grade = "", room = "", dutyDay = "" } = {}) {
  const d = normalizeDateKey(dateKey);
  const day = normalizeDutyDay(dutyDay);
  return records.filter((r) => {
    if (r.dateKey !== d) return false;
    if (grade && String(r.grade) !== String(grade)) return false;
    if (room && String(r.room) !== String(room)) return false;
    if (day && normalizeDutyDay(r.dutyDay || weekdayKeyFromDateKey(r.dateKey)) !== day) return false;
    return true;
  });
}

function getUsers({ grade = "", room = "", dutyDay = "" } = {}) {
  const day = normalizeDutyDay(dutyDay);
  return users.filter((u) => {
    if (u.active === false) return false;
    if (u.role !== "student") return false;
    if (grade && String(u.grade) !== String(grade)) return false;
    if (room && String(u.room) !== String(room)) return false;
    if (day && normalizeDutyDay(u.dutyDay) !== day) return false;
    return true;
  });
}

function publicRecord(r) {
  return { ...r };
}

function progressFor(list, scheduledCount = null) {
  const total = list.length;
  const scheduledTotal = scheduledCount === null ? total : Number(scheduledCount || 0);
  const assigned = list.filter((r) => r.status === "assigned" || r.status === "rework").length;
  const submitted = list.filter((r) => r.status === "done").length;
  const reviewed = list.filter((r) => r.status === "reviewed").length;
  const photos = list.filter((r) => !!r.photoUrl).length;
  const done = submitted + reviewed;
  return {
    total,
    scheduledTotal,
    notSelected: Math.max(0, scheduledTotal - total),
    assigned,
    submitted,
    reviewed,
    photos,
    done,
    percent: scheduledTotal ? Math.round((done / scheduledTotal) * 100) : 0
  };
}

function appDataFor(user, params = {}) {
  let dateKey = normalizeDateKey(params.dateKey);
  let grade = clean(params.grade);
  let room = clean(params.room);
  let dutyDay = normalizeDutyDay(params.dutyDay || weekdayKeyFromDateKey(dateKey));

  if (user.role !== "admin") {
    grade = clean(user.grade);
    room = clean(user.room);
    dutyDay = normalizeDutyDay(user.dutyDay) || weekdayKeyFromDateKey(todayKey());
    dateKey = dateKeyForDutyDay(dutyDay);
  } else {
    dutyDay = normalizeDutyDay(params.dutyDay) || weekdayKeyFromDateKey(dateKey);
  }

  const scopedUsers = getUsers({ grade, room, dutyDay }).map(publicUser);
  const recs = getRecords({ dateKey, grade, room, dutyDay }).map(publicRecord);
  const duties = grade && room ? getDutiesForRoom(grade, room) : [];

  return {
    ok: true,
    user: publicUser(user),
    settings: { ...settings },
    dutyDays: DUTY_DAYS,
    rooms: knownRooms(),
    users: scopedUsers,
    records: recs,
    duties,
    progress: progressFor(recs, scopedUsers.length),
    scope: { dateKey, grade, room, dutyDay, dutyDayLabel: dutyDayLabel(dutyDay) },
    storage: {
      mode: googleStorageReady ? "google-sheets-drive" : "memory-fallback",
      sheetId: GOOGLE_SHEET_ID,
      driveFolderId: GOOGLE_DRIVE_FOLDER_ID,
      error: googleStorageReady ? "" : googleInitError
    },
    serverTime: new Date().toISOString()
  };
}
function roomPayload(dateKey, grade, room) {
  const dutyDay = weekdayKeyFromDateKey(dateKey);
  const fakeUser = { role: "student", grade: clean(grade), room: clean(room), dutyDay };
  return appDataFor(fakeUser, { dateKey, grade, room, dutyDay });
}

function emitChange({ dateKey, grade, room, type = "appDataChanged", record = null } = {}) {
  const d = normalizeDateKey(dateKey);
  const g = clean(grade);
  const r = clean(room);
  const payload = roomPayload(d, g, r);
  io.to(roomKey(g, r)).emit("appDataChanged", { type, scope: { dateKey: d, grade: g, room: r }, record, data: payload });
  io.to(roomKey(g, r)).emit("room_progress", payload);
  io.to("admin").emit("appDataChanged", { type, scope: { dateKey: d, grade: g, room: r }, record, data: payload });
  if (type) {
    io.to(roomKey(g, r)).emit(type, record || payload);
    io.to("admin").emit(type, record || payload);
  }
}

function isValidProofImage(photoDataUrl) {
  if (typeof photoDataUrl !== "string") return false;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(photoDataUrl)) return false;
  const base64 = photoDataUrl.split(",")[1] || "";
  if (base64.length < 10000) return false;
  if (base64.length > 18000000) return false;
  return true;
}

function parseDataUrl(photoDataUrl) {
  const match = String(photoDataUrl || "").match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) throw new Error("รูปไม่ถูกต้อง");
  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const buffer = Buffer.from(match[3], "base64");
  return { mimeType, ext, buffer };
}

async function uploadProofToDrive({ photoDataUrl, record, user }) {
  if (!googleStorageReady || !GOOGLE_DRIVE_FOLDER_ID) {
    return { photoUrl: photoDataUrl, photoFileId: "" };
  }

  const { mimeType, ext, buffer } = parseDataUrl(photoDataUrl);
  const safeName = `${record.dateKey}_g${record.grade}_r${record.room}_${record.studentId}_${Date.now()}.${ext}`.replace(/[^a-zA-Z0-9_.-]/g, "_");

  const file = await driveClient.files.create({
    requestBody: {
      name: safeName,
      parents: [GOOGLE_DRIVE_FOLDER_ID],
      mimeType
    },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: "id,name,webViewLink,webContentLink"
  });

  const fileId = file.data.id;
  try {
    await driveClient.permissions.create({
      fileId,
      requestBody: { type: "anyone", role: "reader" }
    });
  } catch (err) {
    console.warn("Could not set Drive public permission:", err.message);
  }

  return {
    photoFileId: fileId,
    photoUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`,
    photoViewUrl: file.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`
  };
}

function normalizeCaptureMode(value) {
  const mode = clean(value);
  const allowed = new Set(["mobile_camera", "gallery_upload", "photo_file", "attachment", "camera"]);
  return allowed.has(mode) ? mode : "photo_file";
}

async function handleAction(body = {}) {
  const action = clean(body.action);

  if (action === "login") {
    const loginId = clean(body.loginId || body.studentId || body.username);
    const password = String(body.password || "");

    if (isAdminLogin(loginId)) {
      if (password !== ADMIN_PASSWORD) throw new Error("รหัสผ่านผู้ดูแลระบบไม่ถูกต้อง");
      const admin = systemAdmin();
      const token = createToken(admin);
      return { ok: true, token, user: publicUser(admin), settings: { ...settings } };
    }

    const studentId = loginId.replace(/\D/g, "");
    const user = users.find((u) => u.active !== false && u.role === "student" && String(u.studentId) === studentId && String(u.password) === password);
    if (!user) throw new Error("เลขประจำตัวหรือรหัสผ่านไม่ถูกต้อง");
    const token = createToken(user);
    return { ok: true, token, user: publicUser(user), settings: { ...settings } };
  }

  if (action === "register") {
    const name = clean(body.name);
    const studentId = clean(body.studentId).replace(/\D/g, "");
    const grade = clean(body.grade);
    const room = clean(body.room);
    const dutyDay = normalizeDutyDay(body.dutyDay);
    const password = String(body.password || "");

    if (!name || !studentId || !grade || !room || !dutyDay || !password) throw new Error("กรุณากรอกข้อมูลสมัครให้ครบ รวมถึงวันเวรประจำสัปดาห์");
    if (!/^\d{1,10}$/.test(studentId)) throw new Error("เลขประจำตัวนักเรียนต้องเป็นตัวเลขเท่านั้น");
    if (isAdminLogin(body.studentId || body.loginId || body.username)) throw new Error("เลขประจำตัวนี้ถูกสงวนไว้สำหรับผู้ดูแลระบบ");
    if (users.some((u) => u.active !== false && u.role === "student" && u.studentId === studentId)) throw new Error("เลขประจำตัวนี้มีบัญชีแล้ว");

    const countInRoomDay = users.filter((u) => u.active !== false && u.role === "student" && u.grade === grade && u.room === room && normalizeDutyDay(u.dutyDay) === dutyDay).length;
    if (countInRoomDay >= Number(settings.maxUsersPerRoom || 60)) throw new Error(`ห้องนี้ใน${dutyDayLabel(dutyDay)}มีสมาชิกครบตามจำนวนที่ตั้งไว้แล้ว`);

    const now = new Date().toISOString();
    const user = {
      userId: id("u"),
      studentId,
      password,
      name,
      grade,
      room,
      dutyDay,
      role: "student",
      active: true,
      createdAt: now,
      updatedAt: now
    };
    users.push(user);
    getDutiesForRoom(grade, room);
    await persist("users");
    await persist("duties");
    const token = createToken(user);
    emitChange({ dateKey: dateKeyForDutyDay(dutyDay), grade, room, type: "user_registered" });
    return { ok: true, token, user: publicUser(user), settings: { ...settings }, scope: { dateKey: dateKeyForDutyDay(dutyDay), grade, room, dutyDay, dutyDayLabel: dutyDayLabel(dutyDay) } };
  }

  if (action === "getAppData") {
    const user = requireAuth(body.token);
    return appDataFor(user, body);
  }

  if (action === "updateProfile") {
    const user = requireAuth(body.token);
    if (user.role === "admin") throw new Error("แอดมินไม่มีโปรไฟล์นักเรียนให้แก้ไข");

    const oldScope = {
      dateKey: dateKeyForDutyDay(user.dutyDay),
      grade: clean(user.grade),
      room: clean(user.room),
      dutyDay: normalizeDutyDay(user.dutyDay)
    };

    const name = clean(body.name).slice(0, 80);
    const grade = clean(body.grade);
    const room = clean(body.room);
    const dutyDay = normalizeDutyDay(body.dutyDay);
    const newPassword = String(body.newPassword || "");

    if (!name || !grade || !room || !dutyDay) throw new Error("กรุณากรอกชื่อ ชั้น ห้อง และวันเวรให้ครบ");
    if (newPassword && newPassword.length < 4) throw new Error("รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร");

    const countInRoomDay = users.filter((u) => u.active !== false && u.role === "student" && u.userId !== user.userId && u.grade === grade && u.room === room && normalizeDutyDay(u.dutyDay) === dutyDay).length;
    if (countInRoomDay >= Number(settings.maxUsersPerRoom || 60)) throw new Error(`ห้องนี้ใน${dutyDayLabel(dutyDay)}มีสมาชิกครบตามจำนวนที่ตั้งไว้แล้ว`);

    const now = new Date().toISOString();
    user.name = name;
    user.grade = grade;
    user.room = room;
    user.dutyDay = dutyDay;
    if (newPassword) user.password = newPassword;
    user.updatedAt = now;

    getDutiesForRoom(grade, room);
    const newDateKey = dateKeyForDutyDay(dutyDay);
    let movedRecords = 0;
    let resetRecords = 0;
    const newDuties = getDutiesForRoom(grade, room);

    records = records.filter((record) => {
      if (record.userId !== user.userId) return true;
      record.userName = user.name;
      record.studentId = user.studentId;

      if (record.status === "done" || record.status === "reviewed") {
        record.updatedAt = now;
        return true;
      }

      const mappedDuty = newDuties.find((d) => clean(d.name) === clean(record.dutyName));
      if (!mappedDuty) {
        resetRecords += 1;
        return false;
      }

      const usedSlots = records.filter((r) => r !== record && r.dateKey === newDateKey && r.grade === grade && r.room === room && r.dutyId === mappedDuty.dutyId).length;
      if (usedSlots >= Number(mappedDuty.slots || 1)) {
        resetRecords += 1;
        return false;
      }

      record.dateKey = newDateKey;
      record.grade = grade;
      record.room = room;
      record.dutyDay = dutyDay;
      record.dutyId = mappedDuty.dutyId;
      record.dutyName = mappedDuty.name;
      record.emoji = mappedDuty.emoji || "📌";
      record.updatedAt = now;
      movedRecords += 1;
      return true;
    });

    await persist("users");
    await persist("records");
    await persist("duties");

    emitChange({ dateKey: oldScope.dateKey, grade: oldScope.grade, room: oldScope.room, type: "profile_updated" });
    emitChange({ dateKey: newDateKey, grade, room, type: "profile_updated" });

    return {
      ok: true,
      user: publicUser(user),
      movedRecords,
      resetRecords,
      oldScope,
      newScope: { dateKey: newDateKey, grade, room, dutyDay, dutyDayLabel: dutyDayLabel(dutyDay) }
    };
  }

  if (action === "chooseDuty") {
    const user = requireAuth(body.token);
    if (user.role === "admin") throw new Error("แอดมินไม่สามารถเลือกเวรแทนนักเรียนจากหน้านี้ได้");

    const dutyDay = normalizeDutyDay(user.dutyDay) || weekdayKeyFromDateKey(todayKey());
    const dateKey = dateKeyForDutyDay(dutyDay);
    const grade = clean(user.grade);
    const room = clean(user.room);
    const dutyId = clean(body.dutyId);
    const customText = clean(body.customText).slice(0, 80);
    if (!dutyId) throw new Error("กรุณาเลือกหน้าที่");

    const roomDuties = getDutiesForRoom(grade, room);
    let duty;
    if (dutyId === "other") {
      if (!customText) throw new Error("กรุณาระบุหน้าที่อื่นๆ");
      duty = {
        dutyId: `custom_${user.userId}_${Date.now()}`,
        grade,
        room,
        emoji: "✍️",
        name: customText,
        slots: 1
      };
    } else {
      duty = roomDuties.find((d) => String(d.dutyId) === String(dutyId));
      if (!duty) throw new Error("ไม่พบหน้าที่ที่เลือก");
    }

    const existing = records.find((r) => r.dateKey === dateKey && r.userId === user.userId);
    if (existing && (existing.status === "done" || existing.status === "reviewed")) {
      throw new Error("ส่งรูปแล้ว ไม่สามารถเปลี่ยนหน้าที่ได้");
    }

    const sameDutyRecords = records.filter((r) => r.dateKey === dateKey && r.grade === grade && r.room === room && r.dutyId === duty.dutyId && (!existing || r.recordId !== existing.recordId));
    if (sameDutyRecords.length >= Number(duty.slots || 1)) throw new Error("หน้าที่นี้เต็มแล้ว");

    const now = new Date().toISOString();
    let record;
    if (existing) {
      existing.dateKey = dateKey;
      existing.grade = grade;
      existing.room = room;
      existing.dutyDay = dutyDay;
      existing.userName = user.name;
      existing.studentId = user.studentId;
      existing.dutyId = duty.dutyId;
      existing.dutyName = duty.name;
      existing.emoji = duty.emoji || "📌";
      existing.status = "assigned";
      existing.note = "";
      existing.photoUrl = "";
      existing.photoFileId = "";
      existing.submittedAt = "";
      existing.reviewedAt = "";
      existing.updatedAt = now;
      record = existing;
    } else {
      record = {
        recordId: id("rec"),
        dateKey,
        grade,
        room,
        dutyDay,
        userId: user.userId,
        studentId: user.studentId,
        userName: user.name,
        dutyId: duty.dutyId,
        dutyName: duty.name,
        emoji: duty.emoji || "📌",
        status: "assigned",
        note: "",
        photoUrl: "",
        photoFileId: "",
        selectedAt: now,
        submittedAt: "",
        reviewedAt: "",
        updatedAt: now
      };
      records.push(record);
    }

    await persist("records");
    emitChange({ dateKey, grade, room, type: "duty_selected", record: publicRecord(record) });
    return { ok: true, record: publicRecord(record) };
  }

  if (action === "submitProof") {
    const user = requireAuth(body.token);
    const recordId = clean(body.recordId);
    const note = clean(body.note).slice(0, 300);
    const photoDataUrl = body.photoDataUrl;
    const captureMode = normalizeCaptureMode(body.captureMode);

    if (!isValidProofImage(photoDataUrl)) throw new Error("รูปไม่ถูกต้อง ต้องเป็นไฟล์รูปภาพที่มีขนาดเหมาะสม");

    const record = records.find((r) => r.recordId === recordId);
    if (!record) throw new Error("ไม่พบข้อมูลเวร");
    if (user.role !== "admin" && record.userId !== user.userId) throw new Error("ส่งหลักฐานแทนคนอื่นไม่ได้");
    if (record.status === "done" || record.status === "reviewed") throw new Error("งานนี้ส่งรูปแล้ว ต้องให้แอดมินกดแก้ก่อน");

    const now = new Date().toISOString();
    const upload = await uploadProofToDrive({ photoDataUrl, record, user });
    record.note = note;
    record.photoUrl = upload.photoUrl;
    record.photoFileId = upload.photoFileId || "";
    record.photoViewUrl = upload.photoViewUrl || "";
    record.status = "done";
    record.captureMode = captureMode;
    record.captureClientAt = clean(body.captureClientAt);
    record.cameraMeta = body.cameraMeta || {};
    record.dutyDay = normalizeDutyDay(record.dutyDay) || weekdayKeyFromDateKey(record.dateKey);
    record.submittedAt = now;
    record.updatedAt = now;

    await persist("records");
    emitChange({ dateKey: record.dateKey, grade: record.grade, room: record.room, type: "proof_uploaded", record: publicRecord(record) });
    return { ok: true, record: publicRecord(record) };
  }

  if (action === "approveRecord") {
    requireAdmin(body.token);
    const record = records.find((r) => r.recordId === clean(body.recordId));
    if (!record) throw new Error("ไม่พบรายการเวร");
    if (!record.photoUrl) throw new Error("ยังไม่มีรูปหลักฐาน");
    record.status = "reviewed";
    record.reviewedAt = new Date().toISOString();
    record.updatedAt = record.reviewedAt;
    await persist("records");
    emitChange({ dateKey: record.dateKey, grade: record.grade, room: record.room, type: "duty_updated_by_admin", record: publicRecord(record) });
    return { ok: true, record: publicRecord(record) };
  }

  if (action === "reworkRecord") {
    requireAdmin(body.token);
    const record = records.find((r) => r.recordId === clean(body.recordId));
    if (!record) throw new Error("ไม่พบรายการเวร");
    record.status = "rework";
    record.updatedAt = new Date().toISOString();
    await persist("records");
    emitChange({ dateKey: record.dateKey, grade: record.grade, room: record.room, type: "duty_updated_by_admin", record: publicRecord(record) });
    return { ok: true, record: publicRecord(record) };
  }

  if (action === "saveDuties") {
    requireAdmin(body.token);
    const grade = clean(body.grade);
    const room = clean(body.room);
    if (!grade || !room) throw new Error("กรุณาเลือกชั้นและห้องก่อนบันทึกหน้าเวร");
    const duties = Array.isArray(body.duties) ? body.duties : [];
    if (!duties.length) throw new Error("ต้องมีหน้าที่อย่างน้อย 1 รายการ");
    const normalized = duties.map((d, i) => ({
      dutyId: clean(d.dutyId) || `d_${grade}_${room}_${i + 1}`,
      grade,
      room,
      emoji: clean(d.emoji) || "📌",
      name: clean(d.name) || "หน้าที่",
      slots: Math.max(1, Math.min(99, Number(d.slots || 1)))
    }));
    dutyMap.set(roomDutyKey(grade, room), normalized);
    await persist("duties");
    emitChange({ dateKey: todayKey(), grade, room, type: "duties_saved" });
    return { ok: true, duties: normalized };
  }

  if (action === "resetPassword") {
    requireAdmin(body.token);
    const user = users.find((u) => u.userId === clean(body.userId) && u.role === "student");
    if (!user) throw new Error("ไม่พบบัญชีนักเรียน");
    user.password = "1234";
    user.updatedAt = new Date().toISOString();
    await persist("users");
    return { ok: true };
  }

  if (action === "deleteUser") {
    requireAdmin(body.token);
    const user = users.find((u) => u.userId === clean(body.userId) && u.role === "student");
    if (!user) throw new Error("ไม่พบบัญชีนักเรียน");
    user.active = false;
    user.updatedAt = new Date().toISOString();
    await persist("users");
    emitChange({ dateKey: dateKeyForDutyDay(user.dutyDay), grade: user.grade, room: user.room, type: "user_deleted" });
    return { ok: true };
  }

  if (action === "updateSettings") {
    requireAdmin(body.token);
    const incoming = body.settings || {};
    if (incoming.schoolName !== undefined) settings.schoolName = clean(incoming.schoolName).slice(0, 100) || settings.schoolName;
    ["openHour", "openMinute", "closeHour", "closeMinute", "maxUsersPerRoom"].forEach((key) => {
      if (incoming[key] !== undefined) settings[key] = Number(incoming[key]);
    });
    await persist("settings");
    io.emit("appDataChanged", { type: "settings_updated", scope: {}, data: null });
    return { ok: true, settings: { ...settings } };
  }

  if (action === "resetToday") {
    requireAdmin(body.token);
    const dateKey = normalizeDateKey(body.dateKey);
    const grade = clean(body.grade);
    const room = clean(body.room);
    const removed = [];
    records = records.filter((r) => {
      const match = r.dateKey === dateKey && (!grade || r.grade === grade) && (!room || r.room === room);
      if (match) removed.push(r);
      return !match;
    });
    await persist("records");
    if (grade && room) emitChange({ dateKey, grade, room, type: "today_reset" });
    else io.to("admin").emit("appDataChanged", { type: "today_reset", scope: { dateKey, grade, room }, data: null });
    return { ok: true, removed: removed.length };
  }

  if (!action) {
    throw new Error("ไม่พบ action ในคำขอ: เว็บอาจยังไม่ได้ส่ง JSON หรือใช้ไฟล์ app.js ตัวเก่า");
  }
  throw new Error("ไม่รู้จัก action: " + action);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "PPK Duty Node Backend",
    realtime: "Socket.IO ready",
    status: "running",
    api: "Apps Script compatible action API ready",
    version: "7.0.0-weekday-profile-sheets-drive",
    adminStorage: "system-only",
    storage: googleStorageReady ? "google-sheets-drive" : "memory-fallback",
    sheetId: GOOGLE_SHEET_ID,
    driveFolderId: GOOGLE_DRIVE_FOLDER_ID,
    storageError: googleStorageReady ? "" : googleInitError
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString(), storage: googleStorageReady ? "google-sheets-drive" : "memory-fallback", storageError: googleStorageReady ? "" : googleInitError });
});

app.post("/", async (req, res) => {
  try {
    const result = await handleAction(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "เกิดข้อผิดพลาด" });
  }
});

app.post("/api", async (req, res) => {
  try {
    const result = await handleAction(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || "เกิดข้อผิดพลาด" });
  }
});

app.get("/api/room-progress", (req, res) => {
  const grade = clean(req.query.grade);
  const room = clean(req.query.room);
  const dateKey = normalizeDateKey(req.query.dateKey || req.query.date);
  if (!grade || !room) return res.status(400).json({ ok: false, error: "ต้องระบุ grade และ room" });
  res.json(roomPayload(dateKey, grade, room));
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join_room", (data) => {
    const grade = clean(data && data.grade);
    const room = clean(data && data.room);
    const dateKey = normalizeDateKey(data && data.dateKey || data && data.date);
    if (!grade || !room) return;
    const key = roomKey(grade, room);
    socket.join(key);
    socket.emit("joined_room", { ok: true, roomKey: key, grade, room, dateKey });
    socket.emit("room_progress", roomPayload(dateKey, grade, room));
  });

  socket.on("join_admin", () => {
    socket.join("admin");
    socket.emit("joined_admin", { ok: true });
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

async function boot() {
  await initGoogleClients();
  if (googleStorageReady) {
    await loadFromSheets();
    await saveSettings();
  } else {
    console.warn("Google storage is not ready; using memory fallback:", googleInitError);
    if (SEED_DEMO) {
      users.push(
        { userId: "u_demo_10001", studentId: "10001", password: "1234", name: "นักเรียนทดสอบ 1", grade: "6", room: "1", role: "student", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dutyDay: "mon" },
        { userId: "u_demo_10002", studentId: "10002", password: "1234", name: "นักเรียนทดสอบ 2", grade: "6", room: "1", role: "student", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dutyDay: "mon" }
      );
    }
  }

  server.listen(PORT, () => {
    console.log(`PPK Duty Node backend running on port ${PORT}`);
    console.log(`Storage mode: ${googleStorageReady ? "google-sheets-drive" : "memory-fallback"}`);
  });
}

boot().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
