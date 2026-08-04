// ============================================================
// 30 дней в движении — Telegram-бот на Cloudflare Workers + D1
// ============================================================

const YES_NO_KEYBOARD = {
  keyboard: [[{ text: 'Да' }, { text: 'Нет' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
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
  if (nextAfter === 'steps') {
    await setSession(env, from.id, 'ASK_STEPS', {});
    await sendMessage(env, chatId, '🚶 Сколько шагов сделал(а) сегодня? Напиши число.');
  } else {
    await clearSession(env, from.id);
    await sendMessage(env, chatId, 'Готово! Чтобы внести активность за сегодня — отправь /steps');
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
      await sendMessage(env, chatId, 'С возвращением! Чтобы внести активность за сегодня — отправь /steps');
    }
    return new Response('OK');
  }

  if (text === '/steps') {
    if (!user.full_name || !user.city) {
      await askNameOrContinue(env, chatId, from, user, 'steps');
    } else {
      await setSession(env, from.id, 'ASK_STEPS', {});
      await sendMessage(env, chatId, '🚶 Сколько шагов сделал(а) сегодня? Напиши число.');
    }
    return new Response('OK');
  }

  if (!session) {
    await sendMessage(env, chatId, 'Чтобы внести активность за сегодня, отправь /steps');
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

  if (state === 'ASK_STEPS') {
    const steps = parseInt(text.replace(/\D/g, ''), 10);
    if (isNaN(steps) || steps < 0 || steps > 100000) {
      await sendMessage(env, chatId, 'Не похоже на число шагов 🤔 Напиши, например: 8500');
      return new Response('OK');
    }
    data.steps = steps;
    await setSession(env, from.id, 'ASK_TOGETHER', data);
    await sendMessage(env, chatId, '🤝 Была сегодня совместная активность с коллегой (прогулка, тренировка вместе)?', YES_NO_KEYBOARD);
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
    await sendMessage(env, chatId, '📸 Пришли скриншот трекера активности за сегодня (фото).');
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
    data.steps +
    (data.together === 1 ? 1000 : 0) +
    (data.community === 1 && communityBonusAllowed ? 2000 : 0);

  await env.DB.prepare(
    `INSERT INTO entries (user_id, entry_date, steps, together, community, photo_file_id, photo_url, points, status)
     VALUES (?,?,?,?,?,?,?,'pending')
     ON CONFLICT(user_id, entry_date) DO UPDATE SET
       steps=excluded.steps, together=excluded.together,
       community=excluded.community, photo_file_id=excluded.photo_file_id, photo_url=excluded.photo_url,
       points=excluded.points, status='pending', updated_at=datetime('now')`
  )
    .bind(user.id, date, data.steps, data.together, data.community, fileId, photoUrl, points)
    .run();

  let breakdown = `✅ Записано за ${date}:\n\n🚶 Шаги: ${data.steps} = ${data.steps} баллов`;
  if (data.together === 1) breakdown += `\n🤝 Совместная активность: +1000 баллов`;
  if (data.community === 1) {
    breakdown += communityBonusAllowed
      ? `\n🏃 Тренировка комьюнити: +2000 баллов`
      : `\n🏃 Тренировка комьюнити: бонус на этой неделе уже использован`;
  }
  breakdown += `\n\n💰 Итого: ${points} баллов\n\nЗаявка отправлена на проверку модератору.`;

  await sendMessage(env, chatId, breakdown);

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
          steps: data.steps,
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

// ---------------- Stats for dashboard ----------------

async function handleStats(env) {
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(points),0) as total_points, COALESCE(SUM(steps),0) as total_steps,
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

  const topSteps = await env.DB.prepare(
    `SELECT u.full_name, u.username, u.city, SUM(e.steps) as steps
     FROM entries e JOIN users u ON u.id=e.user_id
     WHERE e.status != 'rejected'
     GROUP BY e.user_id ORDER BY steps DESC LIMIT 10`
  ).all();

  const body = {
    total_points: totals.total_points,
    total_steps: totals.total_steps,
    participants: totals.participants,
    cities_count: cities.results.length,
    cities: cities.results.map((c) => c.city),
    leaderboard: top.results,
    leaderboard_steps: topSteps.results,
    updated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
