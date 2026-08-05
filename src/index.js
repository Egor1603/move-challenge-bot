// ============================================================
// 30 дней в движении — Telegram-бот на Cloudflare Workers + D1
// ============================================================

const YES_NO_KEYBOARD = {
  keyboard: [[{ text: 'Да' }, { text: 'Нет' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const MAIN_MENU_KEYBOARD = {
  keyboard: [[{ text: '🏃 Новая пробежка' }, { text: '📊 Мой рейтинг' }]],
  resize_keyboard: true,
};
const REMOVE_KEYBOARD = { remove_keyboard: true };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      try {
        return await handleWebhook(request, env);
      } catch (e) {
        console.error(e);
        return new Response('OK'); // Telegram не любит ошибки, всегда отвечаем 200
      }
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      return handleStats(env);
    }

    if (request.method === 'GET' && url.pathname === '/setup-webhook') {
      // Разовый эндпоинт, чтобы прописать вебхук Telegram (см. README)
      return setupWebhook(request, env);
    }

    return new Response('Move Challenge Bot is running');
  },
};

// ---------------- Telegram helpers ----------------

async function tgCall(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function sendMessage(env, chatId, text, keyboard) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  payload.reply_markup = keyboard || REMOVE_KEYBOARD;
  return tgCall(env, 'sendMessage', payload);
}

async function getPhotoUrl(env, fileId) {
  const res = await tgCall(env, 'getFile', { file_id: fileId });
  if (!res.ok) return null;
  return `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${res.result.file_path}`;
}

async function setupWebhook(request, env) {
  const url = new URL(request.url);
  const workerUrl = `${url.protocol}//${url.host}/webhook`;
  const res = await tgCall(env, 'setWebhook', { url: workerUrl });
  return new Response(JSON.stringify(res, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

// ---------------- Date helpers ----------------

function todayDateStr() {
  // Екатеринбург = UTC+5
  const now = new Date();
  const yekt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return yekt.toISOString().slice(0, 10);
}

function weekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0 = воскресенье
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

// ---------------- DB helpers ----------------

async function getOrCreateUser(env, from) {
  let user = await env.DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(from.id).first();
  if (!user) {
    await env.DB.prepare('INSERT INTO users (tg_id, username, full_name) VALUES (?,?,NULL)')
      .bind(from.id, from.username || '')
      .run();
    user = await env.DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(from.id).first();
  }
  return user;
}

async function getSession(env, tgId) {
  const row = await env.DB.prepare('SELECT state, data FROM sessions WHERE tg_id=?').bind(tgId).first();
  if (!row) return null;
  return { state: row.state, data: JSON.parse(row.data) };
}

async function setSession(env, tgId, state, data) {
  await env.DB.prepare(
    `INSERT INTO sessions (tg_id, state, data, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(tg_id) DO UPDATE SET state=excluded.state, data=excluded.data, updated_at=datetime('now')`
  )
    .bind(tgId, state, JSON.stringify(data))
    .run();
}

async function clearSession(env, tgId) {
  await env.DB.prepare('DELETE FROM sessions WHERE tg_id=?').bind(tgId).run();
}

async function weekHasCommunityBonus(env, userId, dateStr) {
  const { start, end } = weekRange(dateStr);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM entries
     WHERE user_id=? AND community=1 AND entry_date>=? AND entry_date<=? AND entry_date != ?`
  )
    .bind(userId, start, end, dateStr)
    .first();
  return row.cnt > 0;
}

// ---------------- Onboarding chain: имя -> город -> дальше ----------------

async function askNameOrContinue(env, chatId, from, user, nextAfter) {
  if (!user.full_name) {
    await setSession(env, from.id, 'ASK_NAME', { next: nextAfter });
    await sendMessage(env, chatId, 'Как тебя зовут? Напиши имя и фамилию — так ты будешь отображаться в общем рейтинге.');
    return;
  }
  await askCityOrContinue(env, chatId, from, user, nextAfter);
}

async function askCityOrContinue(env, chatId, from, user, nextAfter) {
  if (!user.city) {
    await setSession(env, from.id, 'ASK_CITY', { next: nextAfter });
    await sendMessage(env, chatId, 'Укажи свой город (напиши текстом):');
    return;
  }
  await proceedNext(env, chatId, from, nextAfter);
}

async function proceedNext(env, chatId, from, nextAfter) {
  if (nextAfter === 'run') {
    await setSession(env, from.id, 'ASK_KM', {});
    await sendMessage(env, chatId, '🏃 Сколько километров пробежал(а) сегодня? Напиши число (можно с дробной частью, например 5.4).');
  } else {
    await clearSession(env, from.id);
    await sendMessage(env, chatId, 'Готово! Выбери действие 👇', MAIN_MENU_KEYBOARD);
  }
}

// ---------------- Main webhook logic ----------------

async function handleWebhook(request, env) {
  const update = await request.json();
  const msg = update.message;
  if (!msg) return new Response('OK');

  const chatId = msg.chat.id;
  const from = msg.from;
  const text = (msg.text || '').trim();

  const user = await getOrCreateUser(env, from);
  const session = await getSession(env, from.id);

  if (text === '/start') {
    if (!user.full_name || !user.city) {
      await sendMessage(env, chatId, 'Привет! 👋 Это бот челленджа «30 дней в движении».');
      await askNameOrContinue(env, chatId, from, user, null);
    } else {
      await sendMessage(env, chatId, 'С возвращением! Выбери действие 👇', MAIN_MENU_KEYBOARD);
    }
    return new Response('OK');
  }

  if (text === '/run' || text === '/steps' || text === '🏃 Новая пробежка') {
    if (!user.full_name || !user.city) {
      await askNameOrContinue(env, chatId, from, user, 'run');
    } else {
      await setSession(env, from.id, 'ASK_KM', {});
      await sendMessage(env, chatId, '🏃 Сколько километров пробежал(а) сегодня? Напиши число (можно с дробной частью, например 5.4).');
    }
    return new Response('OK');
  }

  if (text === '📊 Мой рейтинг') {
    await sendMyRank(env, chatId, user);
    return new Response('OK');
  }

  if (!session) {
    await sendMessage(env, chatId, 'Чтобы внести пробежку за сегодня, отправь /run', MAIN_MENU_KEYBOARD);
    return new Response('OK');
  }

  const { state, data } = session;

  if (state === 'ASK_NAME') {
    if (!text || text.trim().length < 2) {
      await sendMessage(env, chatId, 'Напиши, пожалуйста, имя и фамилию текстом 🙂');
      return new Response('OK');
    }
    await env.DB.prepare('UPDATE users SET full_name=? WHERE tg_id=?').bind(text.trim(), from.id).run();
    const updatedUser = await env.DB.prepare('SELECT * FROM users WHERE tg_id=?').bind(from.id).first();
    await askCityOrContinue(env, chatId, from, updatedUser, data.next);
    return new Response('OK');
  }

  if (state === 'ASK_CITY') {
    if (!text) {
      await sendMessage(env, chatId, 'Напиши город текстом 🙂');
      return new Response('OK');
    }
    await env.DB.prepare('UPDATE users SET city=? WHERE tg_id=?').bind(text, from.id).run();
    await proceedNext(env, chatId, from, data.next);
    return new Response('OK');
  }

  if (state === 'ASK_KM') {
    const km = parseFloat(text.replace(',', '.').replace(/[^0-9.]/g, ''));
    if (isNaN(km) || km < 0 || km > 200) {
      await sendMessage(env, chatId, 'Не похоже на дистанцию 🤔 Напиши, например: 5.4');
      return new Response('OK');
    }
    data.km = Math.round(km * 100) / 100;
    await setSession(env, from.id, 'ASK_TOGETHER', data);
    await sendMessage(env, chatId, '🤝 Был сегодня совместный бег с коллегой?', YES_NO_KEYBOARD);
    return new Response('OK');
  }

  if (state === 'ASK_TOGETHER') {
    if (text !== 'Да' && text !== 'Нет') {
      await sendMessage(env, chatId, 'Выбери «Да» или «Нет» на клавиатуре 👇', YES_NO_KEYBOARD);
      return new Response('OK');
    }
    data.together = text === 'Да' ? 1 : 0;
    await setSession(env, from.id, 'ASK_COMMUNITY', data);
    await sendMessage(env, chatId, '🏃 Был(а) сегодня на тренировке/встрече спортивного комьюнити Точки?', YES_NO_KEYBOARD);
    return new Response('OK');
  }

  if (state === 'ASK_COMMUNITY') {
    if (text !== 'Да' && text !== 'Нет') {
      await sendMessage(env, chatId, 'Выбери «Да» или «Нет» на клавиатуре 👇', YES_NO_KEYBOARD);
      return new Response('OK');
    }
    data.community = text === 'Да' ? 1 : 0;
    await setSession(env, from.id, 'ASK_PHOTO', data);
    await sendMessage(env, chatId, '📸 Пришли скриншот трекера бега за сегодня (фото).');
    return new Response('OK');
  }

  if (state === 'ASK_PHOTO') {
    const photo = msg.photo && msg.photo[msg.photo.length - 1];
    if (!photo) {
      await sendMessage(env, chatId, 'Нужно именно фото 🙂 Пришли скриншот трекера.');
      return new Response('OK');
    }
    await saveEntry(env, user, data, photo.file_id, from, chatId);
    await clearSession(env, from.id);
    return new Response('OK');
  }

  return new Response('OK');
}

async function saveEntry(env, user, data, fileId, from, chatId) {
  const date = todayDateStr();
  const photoUrl = await getPhotoUrl(env, fileId);

  let communityBonusAllowed = true;
  if (data.community === 1) {
    communityBonusAllowed = !(await weekHasCommunityBonus(env, user.id, date));
  }

  const points =
    Math.round(data.km * 100) +
    (data.together === 1 ? 1000 : 0) +
    (data.community === 1 && communityBonusAllowed ? 2000 : 0);

  await env.DB.prepare(
    `INSERT INTO entries (user_id, entry_date, steps, together, community, photo_file_id, photo_url, points, status)
     VALUES (?,?,?,?,?,?,?,?,'pending')
     ON CONFLICT(user_id, entry_date) DO UPDATE SET
       steps=excluded.steps, together=excluded.together,
       community=excluded.community, photo_file_id=excluded.photo_file_id, photo_url=excluded.photo_url,
       points=excluded.points, status='pending', updated_at=datetime('now')`
  )
    .bind(user.id, date, data.km, data.together, data.community, fileId, photoUrl, points)
    .run();

  let breakdown = `✅ Записано за ${date}:\n\n🏃 Дистанция: ${data.km} км = ${Math.round(data.km * 100)} баллов`;
  if (data.together === 1) breakdown += `\n🤝 Совместный бег: +1000 баллов`;
  if (data.community === 1) {
    breakdown += communityBonusAllowed
      ? `\n🏃 Тренировка комьюнити: +2000 баллов`
      : `\n🏃 Тренировка комьюнити: бонус на этой неделе уже использован`;
  }
  breakdown += `\n\n💰 Итого: ${points} баллов\n\nЗаявка отправлена на проверку модератору.`;

  await sendMessage(env, chatId, breakdown);
  await sendLeaderboards(env, chatId);

  if (env.SHEETS_WEBHOOK_URL) {
    try {
      await fetch(env.SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          tg_id: from.id,
          username: from.username || '',
          full_name: user.full_name || '',
          city: user.city,
          km: data.km,
          together: data.together,
          community: data.community,
          community_bonus_allowed: communityBonusAllowed,
          points,
          photo_url: photoUrl,
        }),
      });
    } catch (e) {
      // не блокируем бота, если Google недоступен
    }
  }
}

async function sendLeaderboards(env, chatId) {
  const topPoints = await env.DB.prepare(
    `SELECT u.full_name, u.username, SUM(e.points) as points
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected'
     GROUP BY e.user_id ORDER BY points DESC LIMIT 10`
  ).all();

  const topKm = await env.DB.prepare(
    `SELECT u.full_name, u.username, SUM(e.steps) as km
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected'
     GROUP BY e.user_id ORDER BY km DESC LIMIT 10`
  ).all();

  const nameOf = (row) => row.full_name || row.username || 'Участник';

  let text = '🏆 <b>Топ-10 по баллам</b>\n';
  if (topPoints.results.length === 0) {
    text += 'Пока пусто\n';
  } else {
    topPoints.results.forEach((row, i) => {
      text += `${i + 1}. ${nameOf(row)} — ${row.points.toLocaleString('ru-RU')} баллов\n`;
    });
  }

  text += '\n🏃 <b>Топ-10 по километрам</b>\n';
  if (topKm.results.length === 0) {
    text += 'Пока пусто\n';
  } else {
    topKm.results.forEach((row, i) => {
      text += `${i + 1}. ${nameOf(row)} — ${row.km} км\n`;
    });
  }

  await sendMessage(env, chatId, text, MAIN_MENU_KEYBOARD);
}

async function sendMyRank(env, chatId, user) {
  const pointsRows = (
    await env.DB.prepare(
      `SELECT user_id, SUM(points) as points FROM entries WHERE status != 'rejected' GROUP BY user_id ORDER BY points DESC`
    ).all()
  ).results;
  const kmRows = (
    await env.DB.prepare(
      `SELECT user_id, SUM(steps) as km FROM entries WHERE status != 'rejected' GROUP BY user_id ORDER BY km DESC`
    ).all()
  ).results;

  const total = pointsRows.length;
  const pointsIdx = pointsRows.findIndex((r) => r.user_id === user.id);
  const kmIdx = kmRows.findIndex((r) => r.user_id === user.id);

  if (pointsIdx === -1) {
    await sendMessage(
      env,
      chatId,
      'У тебя пока нет ни одной засчитанной пробежки. Нажми «🏃 Новая пробежка», чтобы начать!',
      MAIN_MENU_KEYBOARD
    );
    return;
  }

  const myPoints = pointsRows[pointsIdx].points;
  const myKm = kmRows[kmIdx].km;

  const text =
    `📊 <b>Твой результат</b>\n\n` +
    `💰 Баллы: ${myPoints.toLocaleString('ru-RU')} (место ${pointsIdx + 1} из ${total})\n` +
    `🏃 Километры: ${myKm} (место ${kmIdx + 1} из ${total})`;

  await sendMessage(env, chatId, text, MAIN_MENU_KEYBOARD);
}

// ---------------- Stats for dashboard ----------------

async function handleStats(env) {
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(points),0) as total_points, COALESCE(SUM(steps),0) as total_km,
     COUNT(DISTINCT user_id) as participants
     FROM entries WHERE status != 'rejected'`
  ).first();

  const cities = await env.DB.prepare(
    `SELECT DISTINCT u.city FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected' AND u.city IS NOT NULL AND u.city != ''`
  ).all();

  const top = await env.DB.prepare(
    `SELECT u.full_name, u.username, u.city, SUM(e.points) as points, COUNT(*) as days
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected'
     GROUP BY e.user_id ORDER BY points DESC LIMIT 10`
  ).all();

  const topKm = await env.DB.prepare(
    `SELECT u.full_name, u.username, u.city, SUM(e.steps) as km
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected'
     GROUP BY e.user_id ORDER BY km DESC LIMIT 10`
  ).all();

  const body = {
    total_points: totals.total_points,
    total_km: Math.round(totals.total_km * 10) / 10,
    participants: totals.participants,
    cities_count: cities.results.length,
    cities: cities.results.map((c) => c.city),
    leaderboard: top.results,
    leaderboard_km: topKm.results,
    updated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}
