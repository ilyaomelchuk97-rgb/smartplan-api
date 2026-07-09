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

    // Supabase (отключено — используем Render PostgreSQL)
    useSupabase: false,
    supabaseUrl: '',
    supabaseKey: '',

    // API-ключ Яндекс.Карт
    yandexApiKey: 'afeff61e-01b7-4e22-a0b9-76a7858df31c',

    // === НАСТРОЙКИ ПОГОДНОГО API ===
    weatherProvider: 'open-meteo',
    weatherApiKey: '',
    weatherLat: 53.9023,
    weatherLng: 27.5619,

    // Нормативы рабочего времени
    workHoursPerDay: 8.0,

    // Эндпоинты REST API
    endpoints: {
      users:   '/api/users',
      works:   '/api/works',
      objects: '/api/objects',
      tasks:   '/api/tasks',
      auth:    '/api/auth',
      seed:    '/api/seed',
      health:  '/api/health'
    }
  };
})();
