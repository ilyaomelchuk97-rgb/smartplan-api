/* ============================================================
   SmartPlan — ГЛОБАЛЬНАЯ КОНФИГУРАЦИЯ СИСТЕМЫ (config.js)
   ------------------------------------------------------------
   Настройки для деплоя:
   - Фронтенд: Netlify
   - Бэкенд:   Render (Node.js + PostgreSQL)
   ============================================================ */
window.SP_CONFIG = (function () {
  'use strict';

  // URL вашего бэкенда на Render (замените после деплоя!)
  // При деплое на Render: https://smartplan-api.onrender.com
  var API_URL = (function() {
    // Автоопределение: если запущено локально — localhost
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }
    // Продакшен — адрес вашего API на Render
    // ⚠️ ЗАМЕНИТЕ на свой URL после деплоя!
    return 'https://smartplan-api.onrender.com';
  })();

  return {
    // URL REST API сервера
    serverUrl: API_URL,

    // Режим сервера (true = данные на сервере, false = localStorage)
    useServerApi: true,

    // Общая сетевая папка для синхронизации нескольких пользователей (без сервера).
    // Показывается в окне синхронизации как папка для подключения.
    syncFolder: '\\\\nas1\\Общая папка\\СЭОГС\\smartplan',

    // Ключ Яндекс.Карт (бесплатный: developer.tech.yandex.ru) — включает
    // ОФИЦИАЛЬНЫЙ роутер Яндекса на странице «Тест» (км/время по Яндексу).
    // Пусто — используется дорожный расчёт с показом на Яндекс-карте.
    yandexApiKey: '',

    // Ключи для routing API
    graphhopperApiKey: '57ef5c01-ff24-49f4-8131-b32511a787ed',
    orsApiKey: '11b38c9c9b090561281cb083210e428eevIh0hgxdCE',

    // Stadia Maps (Valhalla) — движок с РОДНОЙ поддержкой exclude_polygons
    // (реальный объезд закрытых дорог, а не via-point костыль). Рекомендуется как основной.
    // Бесплатно: 2500 кредитов/мес (≈62 оптимизированных маршрута), без банковской карты.
    // Получить ключ: https://client.stadiamaps.com/plans/ → план Free → скопировать API key
    stadiaApiKey: '',  // ⚠️ Вставьте ключ Stadia Maps для включения объезда закрытых дорог
    valhallaApiUrl: 'https://api.stadiamaps.com',

    // Ключ MapTiler OMT (OpenMapTiles) — для слоя карты OSRM ТОЛЬКО на русском языке.
    // Бесплатно: 100 000 загрузок тайлов/мес (cloud.maptiler.com).
    maptilerApiKey: 'W7EjXYGEA3hzkGvx81JM',

    // Геокодеры (оставь пустым — будет пропущен; заполнить когда получишь ключ)
    twogisKey: '',       // https://dev.2gis.ru/ → ключ для Catalog API
    opencageKey: '',     // https://opencagedata.com/ → 2500 запросов/день бесплатно

    // Координаты для погоды
    weatherLat: 53.9023,
    weatherLng: 27.5619,

    // Нормативы рабочего времени
    workHoursPerDay: 8.0,

    // Эндпоинты REST API
    endpoints: {
      users:   '/api/users',
      works:   '/api/works',
      areas:   '/api/areas',
      objects: '/api/objects',
      tasks:   '/api/tasks',
      auth:    '/api/auth',
      seed:    '/api/seed',
      health:  '/api/health'
    }
  };
})();
