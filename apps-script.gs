// Вставь этот код в Google Apps Script (script.google.com -> New project),
// привязанный к нужной Google Таблице. Затем Deploy -> New deployment ->
// Web app, Execute as: Me, Who has access: Anyone. Скопируй полученный URL
// веб-приложения и вставь его в переменную SHEETS_WEBHOOK_URL в Cloudflare Worker.

function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // Если это первая запись — добавим заголовки
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Дата', 'Telegram ID', 'Username', 'Имя', 'Город',
      'Шаги', 'Минуты тренировки', 'Вместе с коллегой', 'Комьюнити',
      'Бонус комьюнити начислен', 'Баллы', 'Скриншот', 'Статус'
    ]);
  }

  const data = JSON.parse(e.postData.contents);

  sheet.appendRow([
    data.date,
    data.tg_id,
    data.username,
    data.full_name,
    data.city,
    data.steps,
    data.minutes,
    data.together ? 'Да' : 'Нет',
    data.community ? 'Да' : 'Нет',
    data.community_bonus_allowed ? 'Да' : 'Нет',
    data.points,
    data.photo_url,
    'pending'
  ]);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
