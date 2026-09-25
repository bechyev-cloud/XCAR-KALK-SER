// Простое встроенное хранилище на файловой системе (JSON), без внешних
// npm-зависимостей и без нативных модулей (чтобы гарантированно собиралось
// на Render без дополнительной настройки). Пароли хешируются встроенным
// в Node.js модулем crypto (scrypt + соль) — в открытом виде пароль
// нигде не хранится.
//
// Структура файла:
// {
//   "accounts": {
//     "<логин в нижнем регистре>": {
//       "username": "Идрис",
//       "passwordHash": "<соль>:<хеш>",
//       "email": "...", "phone": "...",
//       "payload": {...}, "updatedAt": 172..., "createdAt": 172...
//     }
//   }
// }

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("./webpush");

const DB_PATH = process.env.XCAR_DB_PATH || path.join(__dirname, "data", "xcar.db.json");

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const SUBSCRIPTION_DEFAULT_DAYS = 365;

function loadRaw() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) return { accounts: {}, subscriptionRequests: [], blacklistPages: [] };
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.accounts) return { accounts: {}, subscriptionRequests: [], blacklistPages: [] };
    if (!Array.isArray(parsed.subscriptionRequests)) parsed.subscriptionRequests = [];
    if (!Array.isArray(parsed.blacklistPages)) parsed.blacklistPages = [];
    return parsed;
  } catch (e) {
    console.error("Не удалось прочитать базу данных, начинаю с чистого листа:", e.message);
    return { accounts: {}, subscriptionRequests: [], blacklistPages: [] };
  }
}

function saveRaw(data) {
  ensureDir();
  const tmpPath = DB_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data), "utf8");
  fs.renameSync(tmpPath, DB_PATH); // атомарная замена файла
}

function accountKey(username) {
  return String(username).trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  let suppliedHash;
  try {
    suppliedHash = crypto.scryptSync(password, salt, 64);
  } catch (e) {
    return false;
  }
  const storedBuf = Buffer.from(hash, "hex");
  if (storedBuf.length !== suppliedHash.length) return false;
  return crypto.timingSafeEqual(storedBuf, suppliedHash);
}

function getAccount(username) {
  const data = loadRaw();
  return data.accounts[accountKey(username)] || null;
}

function accountExists(username) {
  return !!getAccount(username);
}

function publicView(rec) {
  return {
    username: rec.username,
    email: rec.email || "",
    phone: rec.phone || "",
    payload: rec.payload,
    updatedAt: rec.updatedAt,
    subscriptionUntil: rec.subscriptionUntil || 0,
  };
}

function createAccount(username, password, email, phone, payload) {
  const data = loadRaw();
  const key = accountKey(username);
  if (data.accounts[key]) return null; // уже существует
  const now = Date.now();
  const rec = {
    username: String(username).trim(),
    passwordHash: hashPassword(password),
    email: email || "",
    phone: phone || "",
    payload: payload || { cars: [], history: [], settings: { billingMode: "prepay" } },
    updatedAt: now,
    createdAt: now,
    pushSubscriptions: [],
    subscriptionUntil: now + SUBSCRIPTION_DEFAULT_DAYS * 86400000,
  };
  data.accounts[key] = rec;
  saveRaw(data);
  return publicView(rec);
}

// Возвращает { ok:true, rec } или { error: "not_found" | "bad_password" }
function verifyLogin(username, password) {
  const rec = getAccount(username);
  if (!rec) return { error: "not_found" };
  if (!verifyPassword(password, rec.passwordHash)) return { error: "bad_password" };
  return { ok: true, rec: publicView(rec) };
}

// Синхронизация по принципу "последнее изменение побеждает": если у клиента
// clientUpdatedAt >= того, что хранится на сервере, сохраняем присланные
// клиентом данные и возвращаем их же с новым updatedAt; иначе возвращаем
// то, что уже хранится на сервере, ничего не перезаписывая.
function syncAccount(username, password, clientUpdatedAt, payload) {
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  if (!verifyPassword(password, existing.passwordHash)) return { error: "bad_password" };
  if ((clientUpdatedAt || 0) >= existing.updatedAt) {
    existing.payload = payload;
    existing.updatedAt = clientUpdatedAt || Date.now();
    data.accounts[key] = existing;
    saveRaw(data);
  }
  return { ok: true, rec: publicView(existing) };
}

function deleteAccount(username, password) {
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  if (!verifyPassword(password, existing.passwordHash)) return { error: "bad_password" };
  delete data.accounts[key];
  saveRaw(data);
  return { ok: true };
}

// ---------- Push-уведомления (Web Push, RFC 8291/8292 — см. webpush.js) ----------

// Постоянная пара VAPID-ключей сервера — одна на весь сервер, создаётся один раз
// при первом обращении и сохраняется в той же базе данных.
function getVapidPublicKey() {
  const data = loadRaw();
  const { keys, created } = webpush.ensureVapidKeys(data);
  if (created) saveRaw(data);
  return keys.publicKey;
}
function getVapidKeys() {
  const data = loadRaw();
  const { keys, created } = webpush.ensureVapidKeys(data);
  if (created) saveRaw(data);
  return keys;
}

// Добавляет/обновляет push-подписку устройства для аккаунта (дедупликация по endpoint)
function addPushSubscription(username, password, subscription) {
  if (!subscription || typeof subscription !== "object" || !subscription.endpoint || !subscription.keys) {
    return { error: "bad_subscription" };
  }
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  if (!verifyPassword(password, existing.passwordHash)) return { error: "bad_password" };
  if (!Array.isArray(existing.pushSubscriptions)) existing.pushSubscriptions = [];
  existing.pushSubscriptions = existing.pushSubscriptions.filter((s) => s.endpoint !== subscription.endpoint);
  existing.pushSubscriptions.push({
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    addedAt: Date.now(),
  });
  data.accounts[key] = existing;
  saveRaw(data);
  return { ok: true };
}

function removePushSubscription(username, password, endpoint) {
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  if (!verifyPassword(password, existing.passwordHash)) return { error: "bad_password" };
  existing.pushSubscriptions = (existing.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  data.accounts[key] = existing;
  saveRaw(data);
  return { ok: true };
}

// Рассылает push-уведомление на все устройства аккаунта, кроме excludeEndpoint
// (обычно это устройство, которое и вызвало действие — ему уведомление не нужно,
// у него данные и так уже актуальны локально).
async function notifyPush(username, password, notification, excludeEndpoint) {
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  if (!verifyPassword(password, existing.passwordHash)) return { error: "bad_password" };
  const { keys: vapid, created } = webpush.ensureVapidKeys(data);
  if (created) saveRaw(data);
  const subs = existing.pushSubscriptions || [];
  const targets = subs.filter((s) => s.endpoint !== excludeEndpoint);
  let sent = 0, failed = 0;
  const stillValid = [];
  await Promise.all(subs.map(async (sub) => {
    if (sub.endpoint === excludeEndpoint) { stillValid.push(sub); return; }
    try {
      const result = await webpush.sendWebPush({ subscription: sub, payload: notification, vapid });
      if (result.ok) { sent++; stillValid.push(sub); }
      else if (result.gone) { /* подписка больше не действительна — удаляем */ failed++; }
      else { failed++; stillValid.push(sub); } // временная ошибка — оставляем попытаться в другой раз
    } catch (e) {
      failed++;
      stillValid.push(sub); // сетевая ошибка — не удаляем, возможно временно недоступен
    }
  }));
  if (stillValid.length !== subs.length) {
    existing.pushSubscriptions = stillValid;
    data.accounts[key] = existing;
    saveRaw(data);
  }
  return { ok: true, targeted: targets.length, sent, failed };
}

// ---------- Подписка (продление вручную Идрисом после проверки оплаты) ----------

// Продлевает подписку аккаунта на days дней вперёд от текущей даты окончания
// (если она уже в прошлом — от текущего момента). Используется только из
// админ-эндпоинта (защищён ADMIN_KEY на уровне server.js).
function extendSubscription(username, days) {
  const data = loadRaw();
  const key = accountKey(username);
  const existing = data.accounts[key];
  if (!existing) return { error: "not_found" };
  const base = Math.max(existing.subscriptionUntil || 0, Date.now());
  existing.subscriptionUntil = base + (Number(days) || 0) * 86400000;
  data.accounts[key] = existing;
  saveRaw(data);
  return { ok: true, subscriptionUntil: existing.subscriptionUntil };
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Заявка на оплату/продление подписки — просто складываем в список, Идрис
// смотрит их в /admin, проверяет оплату по номеру телефона/ФИО и вручную
// продлевает через extendSubscription.
function addSubscriptionRequest(entry) {
  const data = loadRaw();
  const rec = {
    id: genId(),
    username: typeof entry.username === "string" ? entry.username.trim() : "",
    name: typeof entry.name === "string" ? entry.name.trim().slice(0, 200) : "",
    phone: typeof entry.phone === "string" ? entry.phone.trim().slice(0, 60) : "",
    note: typeof entry.note === "string" ? entry.note.trim().slice(0, 500) : "",
    createdAt: Date.now(),
  };
  data.subscriptionRequests.unshift(rec);
  if (data.subscriptionRequests.length > 500) data.subscriptionRequests.length = 500;
  saveRaw(data);
  return rec;
}

function listSubscriptionRequests() {
  const data = loadRaw();
  return data.subscriptionRequests;
}

function deleteSubscriptionRequest(id) {
  const data = loadRaw();
  const before = data.subscriptionRequests.length;
  data.subscriptionRequests = data.subscriptionRequests.filter((r) => r.id !== id);
  saveRaw(data);
  return { ok: true, removed: before !== data.subscriptionRequests.length };
}

// ---------- Чёрный список (HTML-страницы, которые загружает Идрис) ----------

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function addBlacklistPage(filename, html) {
  const data = loadRaw();
  const rec = {
    id: genId(),
    filename: typeof filename === "string" && filename.trim() ? filename.trim().slice(0, 200) : "страница.html",
    html: String(html || ""),
    uploadedAt: Date.now(),
  };
  data.blacklistPages.unshift(rec);
  if (data.blacklistPages.length > 200) data.blacklistPages.length = 200;
  saveRaw(data);
  return { id: rec.id, filename: rec.filename, uploadedAt: rec.uploadedAt };
}

function listBlacklistPages() {
  const data = loadRaw();
  return data.blacklistPages.map((p) => ({ id: p.id, filename: p.filename, uploadedAt: p.uploadedAt, size: p.html.length }));
}

function deleteBlacklistPage(id) {
  const data = loadRaw();
  const before = data.blacklistPages.length;
  data.blacklistPages = data.blacklistPages.filter((p) => p.id !== id);
  saveRaw(data);
  return { ok: true, removed: before !== data.blacklistPages.length };
}

function getBlacklistMeta() {
  const data = loadRaw();
  const lastUpdatedAt = data.blacklistPages.reduce((max, p) => Math.max(max, p.uploadedAt || 0), 0);
  return { lastUpdatedAt, pagesCount: data.blacklistPages.length };
}

// Ищет query (имя или телефон клиента) по тексту всех загруженных страниц.
// Возвращает совпадающие строки с небольшим контекстом (соседние строки),
// сгруппированные по странице.
function searchBlacklist(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || q.length < 2) return [];
  const data = loadRaw();
  const results = [];
  data.blacklistPages.forEach((p) => {
    const lines = stripHtml(p.html);
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        const context = lines.slice(Math.max(0, i - 1), i + 2).join(" · ");
        results.push({ filename: p.filename, uploadedAt: p.uploadedAt, snippet: context.slice(0, 400) });
      }
    });
  });
  return results.slice(0, 30);
}

module.exports = {
  getAccount, accountExists, createAccount, verifyLogin, syncAccount, deleteAccount, DB_PATH,
  getVapidPublicKey, getVapidKeys, addPushSubscription, removePushSubscription, notifyPush,
  extendSubscription, addSubscriptionRequest, listSubscriptionRequests, deleteSubscriptionRequest,
  addBlacklistPage, listBlacklistPages, deleteBlacklistPage, getBlacklistMeta, searchBlacklist,
  SUBSCRIPTION_DEFAULT_DAYS,
};
