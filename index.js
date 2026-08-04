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
    await env.DB.prepare('INSERT INTO users (tg_id, username, full_name) VALUES (?,?,?)')
      .bind(from.id, from.username || '', `${from.first_name || ''} ${from.last_name || ''}`.trim())
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
    if (!user.city) {
      await setSession(env, from.id, 'ASK_CITY', {});
      await sendMessage(
        env,
        chatId,
        'Привет! 👋 Это бот челленджа «30 дней в движении».\n\nСначала укажи свой город (напиши текстом):'
      );
    } else {
      await sendMessage(env, chatId, 'С возвращением! Чтобы внести активность за сегодня — отправь /steps');
    }
    return new Response('OK');
  }

  if (text === '/steps') {
    if (!user.city) {
      await setSession(env, from.id, 'ASK_CITY', { next: 'steps' });
      await sendMessage(env, chatId, 'Сначала укажи свой город (напиши текстом):');
      return new Response('OK');
    }
    await setSession(env, from.id, 'ASK_STEPS', {});
    await sendMessage(env, chatId, '🚶 Сколько шагов сделал(а) сегодня? Напиши число.');
    return new Response('OK');
  }

  if (!session) {
    await sendMessage(env, chatId, 'Чтобы внести активность за сегодня, отправь /steps');
    return new Response('OK');
  }

  const { state, data } = session;

  if (state === 'ASK_CITY') {
    if (!text) {
      await sendMessage(env, chatId, 'Напиши город текстом 🙂');
      return new Response('OK');
    }
    await env.DB.prepare('UPDATE users SET city=? WHERE tg_id=?').bind(text, from.id).run();
    if (data.next === 'steps') {
      await setSession(env, from.id, 'ASK_STEPS', {});
      await sendMessage(env, chatId, 'Спасибо! Город сохранён.\n\n🚶 Сколько шагов сделал(а) сегодня? Напиши число.');
    } else {
      await clearSession(env, from.id);
      await sendMessage(env, chatId, 'Спасибо! Город сохранён.\n\nЧтобы внести активность за сегодня — отправь /steps');
    }
    return new Response('OK');
  }

  if (state === 'ASK_STEPS') {
    const steps = parseInt(text.replace(/\D/g, ''), 10);
    if (isNaN(steps) || steps < 0 || steps > 100000) {
      await sendMessage(env, chatId, 'Не похоже на число шагов 🤔 Напиши, например: 8500');
      return new Response('OK');
    }
    data.steps = steps;
    await setSession(env, from.id, 'ASK_MINUTES', data);
    await sendMessage(env, chatId, '🏋️ Сколько минут длилась тренировка (не считая ходьбы)? Если не было — напиши 0.');
    return new Response('OK');
  }

  if (state === 'ASK_MINUTES') {
    const minutes = parseInt(text.replace(/\D/g, ''), 10);
    if (isNaN(minutes) || minutes < 0 || minutes > 1000) {
      await sendMessage(env, chatId, 'Напиши число минут, например: 45 (или 0, если тренировки не было)');
      return new Response('OK');
    }
    data.minutes = minutes;
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
    data.minutes * 100 +
    (data.together === 1 ? 1000 : 0) +
    (data.community === 1 && communityBonusAllowed ? 2000 : 0);

  await env.DB.prepare(
    `INSERT INTO entries (user_id, entry_date, steps, activity_minutes, together, community, photo_file_id, photo_url, points, status)
     VALUES (?,?,?,?,?,?,?,?,?,'pending')
     ON CONFLICT(user_id, entry_date) DO UPDATE SET
       steps=excluded.steps, activity_minutes=excluded.activity_minutes, together=excluded.together,
       community=excluded.community, photo_file_id=excluded.photo_file_id, photo_url=excluded.photo_url,
       points=excluded.points, status='pending', updated_at=datetime('now')`
  )
    .bind(user.id, date, data.steps, data.minutes, data.together, data.community, fileId, photoUrl, points)
    .run();

  let breakdown = `✅ Записано за ${date}:\n\n🚶 Шаги: ${data.steps} = ${data.steps} баллов\n🏋️ Тренировка: ${data.minutes} мин = ${data.minutes * 100} баллов`;
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
          full_name: `${from.first_name || ''} ${from.last_name || ''}`.trim(),
          city: user.city,
          steps: data.steps,
          minutes: data.minutes,
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
     COALESCE(SUM(activity_minutes),0) as total_minutes, COUNT(DISTINCT user_id) as participants
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

  const body = {
    total_points: totals.total_points,
    total_steps: totals.total_steps,
    total_hours: Math.round((totals.total_minutes / 60) * 10) / 10,
    participants: totals.participants,
    cities_count: cities.results.length,
    cities: cities.results.map((c) => c.city),
    leaderboard: top.results,
    updated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
