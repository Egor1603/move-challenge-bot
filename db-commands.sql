-- ============================================================
-- 30 дней в движении — шпаргалка по SQL-командам для D1 Console
-- ============================================================
-- Как использовать: Cloudflare Dashboard → Workers & Pages →
-- D1 SQLite Database → move-challenge-db → вкладка Console →
-- вставляешь нужный запрос → Execute.
--
-- ВАЖНО: везде, где встречается TG_ID или id = N — это не текст
-- для копирования как есть. Сначала выполни соответствующий
-- SELECT, найди реальное значение, и только потом подставь
-- его в запрос на удаление/изменение.
-- ============================================================


-- ============================================================
-- ПРОСМОТР ДАННЫХ
-- ============================================================

-- Все пользователи
SELECT * FROM users ORDER BY created_at DESC;

-- Все пробежки, последние сверху
SELECT e.id, e.entry_date, e.steps as km, e.points, u.tg_id, u.full_name, u.city
FROM entries e JOIN users u ON u.id = e.user_id
ORDER BY e.id DESC;

-- Активные (незавершённые) сессии — кто застрял в диалоге
SELECT s.tg_id, s.state, s.data, s.updated_at, u.full_name
FROM sessions s LEFT JOIN users u ON u.tg_id = s.tg_id;

-- Кто не прошёл онбординг (нет имени или города)
SELECT tg_id, username, full_name, city FROM users
WHERE full_name IS NULL OR city IS NULL;

-- Кто написал боту, но ни разу не завершил пробежку
SELECT u.tg_id, u.full_name, u.city, u.created_at
FROM users u LEFT JOIN entries e ON e.user_id = u.id
WHERE e.id IS NULL;


-- ============================================================
-- СТАТИСТИКА
-- ============================================================

-- Общие цифры (как на дашборде)
SELECT COUNT(DISTINCT user_id) as participants,
       SUM(steps) as total_km,
       SUM(points) as total_points
FROM entries WHERE status != 'rejected';

-- Топ-10 по баллам
SELECT u.full_name, u.city, SUM(e.points) as points
FROM entries e JOIN users u ON u.id = e.user_id
WHERE e.status != 'rejected'
GROUP BY e.user_id ORDER BY points DESC LIMIT 10;

-- Топ-10 по километрам
SELECT u.full_name, u.city, SUM(e.steps) as km
FROM entries e JOIN users u ON u.id = e.user_id
WHERE e.status != 'rejected'
GROUP BY e.user_id ORDER BY km DESC LIMIT 10;

-- Активность конкретного человека (замени TG_ID)
SELECT entry_date, steps as km, points, status
FROM entries e JOIN users u ON u.id = e.user_id
WHERE u.tg_id = TG_ID ORDER BY entry_date DESC;

-- Сколько дней с активностью у каждого (для приза «Самый стабильный»)
SELECT u.full_name, COUNT(*) as active_days
FROM entries e JOIN users u ON u.id = e.user_id
WHERE e.status != 'rejected'
GROUP BY e.user_id ORDER BY active_days DESC;

-- Города-участники
SELECT DISTINCT u.city FROM entries e JOIN users u ON u.id = e.user_id
WHERE e.status != 'rejected' AND u.city IS NOT NULL;


-- ============================================================
-- УДАЛЕНИЕ / ОЧИСТКА
-- ============================================================

-- Удалить одну запись о пробежке по id
DELETE FROM entries WHERE id = 5;

-- Удалить все пробежки конкретного пользователя (замени TG_ID)
DELETE FROM entries WHERE user_id = (SELECT id FROM users WHERE tg_id = TG_ID);

-- Сбросить зависшую сессию одного человека (замени TG_ID)
DELETE FROM sessions WHERE tg_id = TG_ID;

-- Удалить ВСЕ зависшие сессии разом (безопасно, не трогает users/entries)
DELETE FROM sessions;

-- Удалить только сессии, зависшие дольше суток
DELETE FROM sessions WHERE updated_at < datetime('now', '-1 day');

-- Сбросить имя пользователя, чтобы бот спросил заново
UPDATE users SET full_name = NULL WHERE tg_id = TG_ID;

-- Полностью удалить пользователя со всей историей (необратимо!)
DELETE FROM entries WHERE user_id = (SELECT id FROM users WHERE tg_id = TG_ID);
DELETE FROM sessions WHERE tg_id = TG_ID;
DELETE FROM users WHERE tg_id = TG_ID;

-- Очистить все тестовые данные перед стартом челленджа
DELETE FROM entries;
DELETE FROM sessions;
-- users можно оставить, чтобы не спрашивать заново имя/город у тех, кто уже тестировал


-- ============================================================
-- МОДЕРАЦИЯ
-- ============================================================

-- Пометить запись как одобренную / отклонённую
UPDATE entries SET status = 'approved' WHERE id = 5;
UPDATE entries SET status = 'rejected' WHERE id = 5;

-- Посмотреть только записи на модерации
SELECT e.id, e.entry_date, e.steps as km, u.full_name, e.photo_url
FROM entries e JOIN users u ON u.id = e.user_id
WHERE e.status = 'pending';
