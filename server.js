// XCAR — сервер регистрации (логин, пароль, email, телефон) и синхронизации.
// Работает только на встроенных модулях Node.js (http, fs, crypto) — без
// npm install, поэтому гарантированно разворачивается на Render.
//
// Эндпоинты:
//   GET    /health                        — проверка живости сервиса
//   POST   /api/register  {username, password, email?, phone?, payload?}
//                                          — создать аккаунт
//   POST   /api/login     {username, password}
//                                          — войти в существующий аккаунт
//   POST   /api/sync      {username, password, updatedAt, payload}
//                                          — синхронизировать данные (последнее изменение побеждает)
//   DELETE /api/account   {username, password}
//                                          — удалить аккаунт и все его данные
//   GET    /api/push/vapid-public-key      — публичный VAPID-ключ сервера для подписки на push
//   POST   /api/push/subscribe    {username, password, subscription}
//                                          — сохранить push-подписку этого устройства
//   POST   /api/push/unsubscribe  {username, password, endpoint}
//                                          — удалить push-подписку устройства
//   POST   /api/push/notify       {username, password, title, body, excludeEndpoint?}
//                                          — отправить push-уведомление на все устройства
//                                            аккаунта, кроме excludeEndpoint (обычно — своё)
//
// Формат payload: { cars: [...], history: [...], settings: {...} } — ровно то,
// что хранит клиент в localStorage. Пароли хранятся только в виде хеша
// (scrypt + случайная соль), см. db.js. Push-уведомления реализованы через
// встроенный Web Push (RFC 8291/8292), см. webpush.js — без npm-пакета web-push.

const http = require("http");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.XCAR_ALLOWED_ORIGIN || "*";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — с запасом для истории и списка машин

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(Object.assign(new Error("invalid json"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d][\d\s\-()]{4,19}$/;

function validateRegisterBody(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!username || username.length < 2) return { error: "Логин должен быть не короче 2 символов" };
  if (username.length > 40) return { error: "Слишком длинный логин" };
  if (!password || password.length < 4) return { error: "Пароль должен быть не короче 4 символов" };
  if (password.length > 200) return { error: "Слишком длинный пароль" };
  if (email && !EMAIL_RE.test(email)) return { error: "Некорректный email" };
  if (phone && !PHONE_RE.test(phone)) return { error: "Некорректный номер телефона" };
  return { username, password, email, phone };
}

function validateLoginBody(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username) return { error: "Укажите логин" };
  if (!password) return { error: "Укажите пароль" };
  return { username, password };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    cars: Array.isArray(payload.cars) ? payload.cars : [],
    history: Array.isArray(payload.history) ? payload.history : [],
    settings: payload.settings && typeof payload.settings === "object" ? payload.settings : { billingMode: "prepay" },
  };
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split("?")[0];

  try {
    if (req.method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === "POST" && url === "/api/register") {
      const body = await readJsonBody(req);
      const cred = validateRegisterBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      if (db.accountExists(cred.username)) {
        return sendJson(res, 409, { error: "Такой логин уже занят" });
      }
      const rec = db.createAccount(cred.username, cred.password, cred.email, cred.phone, validatePayload(body.payload) || undefined);
      return sendJson(res, 201, { ok: true, ...rec });
    }

    if (req.method === "POST" && url === "/api/login") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      const result = db.verifyLogin(cred.username, cred.password);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден — проверьте логин, либо зарегистрируйтесь" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      return sendJson(res, 200, { ok: true, ...result.rec });
    }

    if (req.method === "POST" && url === "/api/sync") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      const payload = validatePayload(body.payload);
      if (!payload) return sendJson(res, 400, { error: "Некорректные данные (payload)" });
      const clientUpdatedAt = typeof body.updatedAt === "number" ? body.updatedAt : 0;
      const result = db.syncAccount(cred.username, cred.password, clientUpdatedAt, payload);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден — сначала зарегистрируйтесь" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      return sendJson(res, 200, result.rec);
    }

    if (req.method === "DELETE" && url === "/api/account") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      const result = db.deleteAccount(cred.username, cred.password);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/api/push/vapid-public-key") {
      return sendJson(res, 200, { publicKey: db.getVapidPublicKey() });
    }

    if (req.method === "POST" && url === "/api/push/subscribe") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      const result = db.addPushSubscription(cred.username, cred.password, body.subscription);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      if (result.error === "bad_subscription") return sendJson(res, 400, { error: "Некорректная push-подписка" });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/push/unsubscribe") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      if (!body.endpoint) return sendJson(res, 400, { error: "Не указан endpoint подписки" });
      const result = db.removePushSubscription(cred.username, cred.password, body.endpoint);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/push/notify") {
      const body = await readJsonBody(req);
      const cred = validateLoginBody(body);
      if (cred.error) return sendJson(res, 400, { error: cred.error });
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "XCAR";
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) return sendJson(res, 400, { error: "Пустое сообщение" });
      const result = await db.notifyPush(cred.username, cred.password, { title, body: text }, body.excludeEndpoint || null);
      if (result.error === "not_found") return sendJson(res, 404, { error: "Аккаунт не найден" });
      if (result.error === "bad_password") return sendJson(res, 401, { error: "Неверный пароль" });
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "Не найдено" });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status === 500) console.error("Ошибка сервера:", e);
    return sendJson(res, status, { error: e.message || "Внутренняя ошибка сервера" });
  }
});

server.listen(PORT, () => {
  console.log(`XCAR sync server запущен на порту ${PORT}`);
  console.log(`База данных: ${db.DB_PATH}`);
});
