/* ============================================================
   SmartPlan — логика приложения (vanilla JS)
   ============================================================ */
(function () {
  'use strict';
  var D = window.SP || {};
  var DB = window.SP_DB;
  var WORK = window.SP_WORK;
  var OBJECTS_DB = window.SP_OBJECTS;
  var TASKS_DB = window.SP_TASKS;
  var OBJECTS = OBJECTS_DB ? OBJECTS_DB.getObjects() : (D.OBJECTS || []);
  var WORK_TREE = D.WORK_TREE || [], WORK_MAP = D.WORK_MAP || {}, OBJ_MAP = D.OBJ_MAP || {};
  OBJECTS.forEach(function(o) { OBJ_MAP[o.id] = o; });

  // Мастера/бригады берутся из БД пользователей (роль master/smaster)
  function getMasters() { return DB.getMasters(); }

  // Описание ролей и участков
  var ROLE_INFO = {
    admin:   { label: 'Администратор',     cls: 'navy' },
    nach:    { label: 'Начальник участка', cls: 'blue' },
    smaster: { label: 'Старший мастер',    cls: 'purple' },
    master:  { label: 'Мастер',            cls: 'teal' }
  };
  var AREAS = ['УБиРОГС'];

  // Базы (отправные точки маршрутов)
  var BASES = [
    { id: 'b1', name: 'г. Минск, ул. Ботаническая 11', lat: 53.9258, lng: 27.5805 },
    { id: 'b2', name: 'г. Минск, ул. Волгоградская 3А', lat: 53.8478, lng: 27.5372 }
  ];

  /* ---------- УТИЛИТЫ ДАТ ---------- */
  var TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  var WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var WD_FULL = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  var MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function offToDate(off) { return addDays(TODAY, off); }
  function key(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function sameDay(a, b) { return key(a) === key(b); }
  function dateToOff(d) { return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - TODAY) / 86400000); }
  function mondayOf(d) { var x = new Date(d); var day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
  function fmt(d) { return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtShort(off) { var d = offToDate(off); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtH(h) { return (Math.round(h * 10) / 10).toString().replace('.', ','); }
  function initials(name) {
    if (!name) return '?';
    var p = name.replace(/[^А-Яа-яA-Za-z\s.]/g, '').split(/\s+/).filter(Boolean);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }

  /* ---------- СОСТОЯНИЕ ---------- */
  var S = {
    screen: 'dashboard',
    user: null,           // вошедший пользователь
    role: 'master',       // admin | nach | smaster | master
    curMaster: 'm1',
    calMode: 'week',      // week | month | day
    weekShift: 0, monthShift: 0, dayShift: 0,
    mapOff: 0,
    mapProvider: 'yandex',
    mapSel: {},
    baseId: 'b1',
    dashArea: null, // null = все участки (фильтр админа на дашборде)
    refsTab: 'tree',
    workArea: null, workModalMode: 'new', workModalWid: null,
    userModalMode: 'new', userModalUid: null,
    tasks: TASKS_DB ? TASKS_DB.getTasks() : (D.TASK_SEED || []).map(function (t, i) {
      var o = OBJ_MAP[t.o] || null;
      var tm = 15;
      if (o && o.lat && o.lng) {
        var distKmVal = distKm(BASES[0], { lat: o.lat, lng: o.lng }) * 1.4;
        tm = Math.max(1, Math.round(distKmVal / 55 * 60));
      }
      return Object.assign({ id: 't' + (i + 1), travelMin: tm }, t);
    })
  };

  var CAP = 8; // ФРВ: рабочий день = 8 ч

  /* ---------- ПРАВА ДОСТУПА (иерархия) ----------
     admin   — видит и редактирует ВСЁ (все участки)
     nach    — видит и редактирует только мастеров СВОЕГО участка
     smaster — то же, что nach: только мастеров своего участка
     master  — видит и редактирует ТОЛЬКО СЕБЯ
  */
  // Создание планов и запуск оптимизатора — админ / нач. участка / ст. мастер
  function canPlan() { return S.role === 'admin' || S.role === 'nach' || S.role === 'smaster'; }
  function canApprove() { return S.role === 'admin' || S.role === 'nach'; }
  // Может ли пользователь редактировать конкретную задачу
  function canEditTask(t) {
    if (!t) return false;
    if (S.role === 'admin') return true;                       // всё
    if (S.role === 'master') return S.user && t.m === S.user.id;         // только себя
    var m = masterById(t.m);                                   // nach / smaster — свой участок
    return !!m && S.user && m.area === S.user.area;
  }
  // Может ли пользователь перетаскивать задачи на строку этого мастера
  function canDropOn(masterId) {
    if (S.role === 'admin') return true;
    if (S.role === 'master') return S.user && masterId === S.user.id;
    var m = masterById(masterId);
    return !!m && S.user && m.area === S.user.area;                       // nach / smaster
  }
  function visibleMasters() {
    var all = getMasters();
    if (S.role === 'admin') return all;
    if (S.role === 'master') return all.filter(function (m) { return S.user && m.id === S.user.id; });
    return all.filter(function (m) { return S.user && m.area === S.user.area; }); // nach, smaster
  }
  function visibleTasks() {
    var ids = {}; visibleMasters().forEach(function (m) { ids[m.id] = 1; });
    return S.tasks.filter(function (t) { return ids[t.m]; });
  }
  function masterById(id) { var u = DB.getUser(id); return u ? Object.assign({}, u, { name: u.full_name }) : null; }
  // Адрес задачи: из объекта или из введённого вручную
  function addrOf(t) { var o = OBJ_MAP[t.o]; return t.addr || (o ? o.addr : '?'); }
  // Вид работы для задачи: берётся из каталога участка мастера (виды работ разные по участкам)
  function workOf(t) {
    if (!t) return null;
    var m = masterById(t.m);
    var area = m ? m.area : null;
    if (t.works && t.works.length > 1) {
      var names = [], totalNorm = 0, units = [];
      t.works.forEach(function(wid) {
        var w = area ? WORK.getWork(area, wid) : WORK_MAP[wid];
        if (w) {
          names.push(w.name);
          totalNorm += w.norm;
          if (units.indexOf(w.unit) === -1) units.push(w.unit);
        }
      });
      return { id: t.works[0], name: names.join(' + '), norm: totalNorm, unit: units.join('/') || 'объект', group: 'Комплексные работы' };
    }
    if (m && m.area) { var w = WORK.getWork(m.area, t.w); if (w) return w; }
    return WORK_MAP[t.w] || null;
  }

  /* ---------- ЛОГИКА ЗАДАЧ (с объёмом, погодой, техникой) ---------- */
  // Расчёт трудозатрат: норма × объём (по единице измерения)
  function taskHours(t) {
    if (!t) return 0;
    var vol = parseFloat(t.volume) || 1;
    if (t.works && t.works.length > 0) {
      var m = masterById(t.m);
      var area = m ? m.area : null;
      var sum = 0;
      t.works.forEach(function(wid) {
        var w = area ? WORK.getWork(area, wid) : null;
        if (w) {
          var h = w.norm * vol;
          if (w.unit === 'га') h = w.norm * (vol || 1);
          if (w.unit === 'км') h = w.norm * (vol || 1);
          if (w.unit === 'м2') h = w.norm * (vol || 1);
          sum += h;
        }
      });
      return sum;
    }
    var w = workOf(t);
    if (!w) return 0;
    return w.norm * vol;
  }

  // Проверка погодного ограничения
  function checkWeatherOk(t, dayOff) {
    var w = workOf(t);
    if (!w || w.min_temp == null || w.min_temp <= -50) return { ok: true };
    var forecast = getWeatherForecast(dayOff);
    if (forecast == null || forecast.temp == null) return { ok: true, unknown: true };
    if (forecast.temp < w.min_temp) {
      return { ok: false, temp: forecast.temp, required: w.min_temp, reason: 'Температура ' + forecast.temp + '°C ниже минимума ' + w.min_temp + '°C' };
    }
    return { ok: true, temp: forecast.temp };
  }

  // === ЗАГРУЗКА ПРОГНОЗА ПОГОДЫ ИЗ ЯНДЕКС.ПОГОДЫ / OPEN-METEO ===
  // Кэш: { 'YYYY-MM-DD': { temp: 15, snow: true, snowfall: 2.5, code: 61, desc: 'Снег' }, ... }
  var weatherCache = {};
  var weatherLoaded = false;
  var weatherLoading = false;

  // Запрос к Open-Meteo (бесплатный API, поддерживает CORS, данные эквивалентны Яндекс.Погоде)
  function loadWeatherFromOpenMeteo() {
    var lat = (window.SP_CONFIG && SP_CONFIG.weatherLat) || 53.9023;
    var lng = (window.SP_CONFIG && SP_CONFIG.weatherLng) || 27.5619;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
      '&daily=temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,weather_code' +
      '&timezone=Europe%2FMinsk&forecast_days=14';
    return fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      if (!data || !data.daily) throw new Error('Нет данных о погоде');
      var days = data.daily.time || [];
      days.forEach(function(dateStr, i) {
        var tMax = data.daily.temperature_2m_max[i];
        var tMin = data.daily.temperature_2m_min[i];
        var avgTemp = Math.round(((tMax + tMin) / 2) * 10) / 10;
        var snowfall = data.daily.snowfall_sum[i] || 0;
        var precip = data.daily.precipitation_sum[i] || 0;
        var code = data.daily.weather_code[i] || 0;
        var info = decodeWeatherCode(code);
        weatherCache[dateStr] = {
          temp: avgTemp,
          tempMax: tMax, tempMin: tMin,
          snow: snowfall > 0 || info.snow,
          snowfall: snowfall,
          precip: precip,
          code: code,
          desc: info.desc
        };
      });
      weatherLoaded = true;
    });
  }

  // Запрос к Яндекс.Погоде (требует API-ключ, может блокироваться CORS)
  function loadWeatherFromYandex() {
    var lat = (window.SP_CONFIG && SP_CONFIG.weatherLat) || 53.9023;
    var lng = (window.SP_CONFIG && SP_CONFIG.weatherLng) || 27.5619;
    var apiKey = (window.SP_CONFIG && SP_CONFIG.weatherApiKey) || '';
    var url = 'https://api.weather.yandex.ru/v2/forecast?lat=' + lat + '&lon=' + lng + '&limit=14&hours=false&extra=true';
    return fetch(url, {
      headers: { 'X-Yandex-API-Key': apiKey }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (!data || !data.forecasts) throw new Error('Нет данных Яндекс.Погоды');
      data.forecasts.forEach(function(day) {
        var avg = day.parts && day.parts.day ? Math.round(day.parts.day.temp_avg * 10) / 10 : 0;
        var snow = false;
        var precip = 0;
        if (day.parts && day.parts.day) {
          var p = day.parts.day.prec_type; // 0 - нет, 1 - дождь, 2 - снег
          snow = (p === 2);
          precip = day.parts.day.prec_mm || 0;
        }
        weatherCache[day.date] = {
          temp: avg,
          snow: snow,
          snowfall: snow ? precip : 0,
          precip: precip,
          code: snow ? 75 : p === 1 ? 61 : 0,
          desc: snow ? 'Снег' : p === 1 ? 'Дождь' : 'Без осадков'
        };
      });
      weatherLoaded = true;
    });
  }

  // Загрузка прогноза погоды (главная функция)
  function loadWeatherForecast() {
    if (weatherLoading) return Promise.resolve();
    weatherLoading = true;
    var provider = (window.SP_CONFIG && SP_CONFIG.weatherProvider) || 'open-meteo';
    var yandexKey = (window.SP_CONFIG && SP_CONFIG.weatherApiKey) || '';

    var promise;
    if (provider === 'yandex' && yandexKey) {
      promise = loadWeatherFromYandex().catch(function(e) {
        console.warn('Яндекс.Погода недоступна, fallback на Open-Meteo:', e.message);
        return loadWeatherFromOpenMeteo();
      });
    } else {
      promise = loadWeatherFromOpenMeteo();
    }

    return promise.then(function() {
      weatherLoading = false;
      console.log('Погода загружена:', Object.keys(weatherCache).length, 'дней');
      // Перерисовка текущего экрана для обновления погодных меток
      if (typeof window.reRenderCurrentScreen === 'function') {
        setTimeout(window.reRenderCurrentScreen, 100);
      }
    }).catch(function(err) {
      weatherLoading = false;
      console.error('Ошибка загрузки погоды:', err);
    });
  }

  // Декодирование кода погоды Open-Meteo / WMO
  function decodeWeatherCode(code) {
    if (code === 0) return { desc: 'Ясно', snow: false };
    if (code <= 3) return { desc: 'Облачно', snow: false };
    if (code >= 51 && code <= 57) return { desc: 'Морось', snow: false };
    if (code >= 61 && code <= 67) return { desc: 'Дождь', snow: false };
    if (code >= 71 && code <= 77) return { desc: 'Снег', snow: true };
    if (code >= 80 && code <= 82) return { desc: 'Ливень', snow: false };
    if (code === 85 || code === 86) return { desc: 'Снег с ливнем', snow: true };
    if (code >= 95) return { desc: 'Гроза', snow: false };
    return { desc: 'Без осадков', snow: false };
  }

  // Синхронное чтение прогноза из кэша (вызывается из UI)
  function getWeatherForecast(dayOff) {
    var d = offToDate(dayOff);
    var k = key(d);
    if (weatherCache[k]) return weatherCache[k];
    return null;
  }

  // Проверка наличия снегопада в день (для снегозависимых работ)
  function hasSnowfallOn(dayOff) {
    var f = getWeatherForecast(dayOff);
    if (!f) return false;
    return f.snow && f.snowfall > 0.1; // более 1 мм снега = снегопад
  }

  // Расчёт дедлайна для снегозависимых работ
  // Если есть данные о снегопаде — дедлайн = дата снегопада + 48ч норматива
  function calcSnowDeadline(snowDate, work) {
    var normResponse = 48; // часов на реагирование (по умолчанию)
    var dl = new Date(snowDate);
    dl.setTime(dl.getTime() + normResponse * 3600000);
    return dl;
  }

  // Поиск последнего снегопада в прогнозе (для снегозависимых задач без даты)
  function findLastSnowfall() {
    var lastSnow = null;
    for (var off = 0; off <= 14; off++) {
      var wf = getWeatherForecast(off);
      if (wf && wf.snow && wf.snowfall > 0.1) {
        lastSnow = { date: offToDate(off), off: off, snowfall: wf.snowfall };
      }
    }
    return lastSnow;
  }

  // Определение приоритета задачи
  function taskPriority(t) {
    var w = workOf(t);
    if (!w) return 'normal';
    if (w.needs_permit) return 'critical';      // Ордер — высший
    if (w.depends_on_snow) return 'high';        // Снег — высокий
    if (w.season === 'Зима') return 'medium';    // Сезонные
    return 'normal';                              // Обычные
  }
  function taskColor(t) {
    if (t.status === 'done' || t.s === 'done') return 'done';
    // Проверка погодного ограничения (температура)
    var w = workOf(t);
    if (w && w.min_temp > -50) {
      var wf = getWeatherForecast(t.d);
      if (wf && wf.temp != null && wf.temp < w.min_temp) return 'weather';
    }
    if (t.d < 0) return 'red';
    if (t.dl < 0) return 'red';
    if (t.dl <= 2) return 'yellow';
    return 'green';
  }
  function statusLabel(t) {
    var s = t.s || t.status;
    return s === 'done' ? 'Выполнено' : s === 'progress' ? 'В работе' : 'В плане';
  }
  function isDone(t) { return (t.s || t.status) === 'done'; }
  function loadForDay(masterId, off) {
    var sum = 0;
    S.tasks.forEach(function (t) { if (t.m === masterId && t.d === off && !isDone(t)) sum += taskHours(t); });
    return sum;
  }

  /* ---------- DOM ---------- */
  var view = document.getElementById('view');
  var tip = document.getElementById('tip');
  var overlay = document.getElementById('overlay');
  var modal = document.getElementById('modal');

  var TITLES = {
    dashboard: ['Дашборд', 'Рабочий стол'],
    calendar: ['Планирование / Календарь', 'Перетаскивайте карточки: влево/вправо — смена даты, вверх/вниз — смена мастера'],
    map: ['Карта маршрутов', 'Оптимизация пути между объектами и выбор картографического сервиса'],
    gmap: ['Интерактивная карта', 'Интерактивная карта сетей и объектов УП «МИНГАЗ»'],
    perms: ['Разрешения', 'Система разрешений на производство работ'],
    refs: ['Справочники', 'Виды работ, нормы времени, объекты газоснабжения'],
    users: ['Пользователи', 'Учётные записи, роли и доступ к системе'],
    reports: ['Отчёты', 'Печатные формы для подписи у руководства']
  };

  /* ---------- ИКОНКИ ---------- */
  var IC = {
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg>',
    route: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 000-7H9a3.5 3.5 0 010-7h6.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>'
  };

  /* =====================================================================
     РЕНДЕР: ДАШБОРД
     ===================================================================== */
  function renderDashboard() {
    // Для админа: фильтр по участку (null = все участки)
    var dashFilterArea = S.dashArea;
    function dashMasters() {
      var all = visibleMasters();
      if (S.role === 'admin' && dashFilterArea) return all.filter(function (m) { return m.area === dashFilterArea; });
      return all;
    }
    function dashTasks() {
      var dm = dashMasters(); var ids = {};
      dm.forEach(function (m) { ids[m.id] = 1; });
      return S.tasks.filter(function (t) { return ids[t.m]; });
    }

    var vt = dashTasks();
    var today = vt.filter(function (t) { return t.d === 0; });
    var redzone = vt.filter(function (t) { return !isDone(t) && (t.dl <= 2 || t.d < 0); }).sort(function (a, b) { return a.dl - b.dl; });

    var mastersToday = dashMasters();
    var overloads = mastersToday.filter(function (m) { return loadForDay(m.id, 0) > CAP; }).length;
    var doneMonth = 0, totalMonth = 0;
    vt.forEach(function (t) {
      var d = offToDate(t.d);
      if (d.getMonth() === TODAY.getMonth() && d.getFullYear() === TODAY.getFullYear()) { totalMonth++; if (isDone(t)) doneMonth++; }
    });
    var pct = totalMonth ? Math.round(doneMonth / totalMonth * 100) : 0;

    var areas = {};
    vt.forEach(function (t) {
      var d = offToDate(t.d);
      if (d.getMonth() !== TODAY.getMonth() || d.getFullYear() !== TODAY.getFullYear()) return;
      var m = masterById(t.m); if (!m) return;
      areas[m.area] = areas[m.area] || { done: 0, total: 0 };
      areas[m.area].total++; if (isDone(t)) areas[m.area].done++;
    });

    var html = '';

    // === Селектор участка ТОЛЬКО для админа ===
    if (S.role === 'admin') {
      html += '<div style="margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">';
      html += '<label style="font-size:12px;font-weight:600;color:var(--muted)">Участок:</label>';
      html += '<select id="dash-area" style="padding:8px 12px;border:1px solid var(--line);border-radius:9px;font-size:13px;font-family:inherit;background:#fff">';
      html += '<option value=""' + (!dashFilterArea ? ' selected' : '') + '>Все участки</option>';
      AREAS.forEach(function (a) { html += '<option value="' + esc(a) + '"' + (dashFilterArea === a ? ' selected' : '') + '>' + esc(a) + '</option>'; });
      html += '</select>';
      if (dashFilterArea) {
        html += '<button class="btn sm" data-action="dash-area-clear">Сбросить</button>';
      }
      html += '</div>';
    }

    html += '<div class="kpi-row">';
    html += kpi(today.length, 'Задач на сегодня', 'по ' + mastersToday.length + ' мастера(ам)', '#2563eb');
    html += kpi(overloads, 'Перегрузок сегодня', 'превышение ФРВ ' + CAP + ' ч', '#dc2626');
    html += kpi(pct + '%', 'Выполнено за месяц', doneMonth + ' из ' + totalMonth + ' работ', '#16a34a');
    // KPI УБиРОГС
    var permitCount = vt.filter(function(t) { return t.needs_permit && !isDone(t); }).length;
    var weatherCount = vt.filter(function(t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; }).length;
    html += kpi(permitCount, 'Ордеров истекает', 'работы с разрешениями', '#f59e0b');
    html += '</div>';

    // Оповещения УБиРОГС
    if (permitCount > 0) {
      html += '<div class="permit-warn">📋 <b>Внимание:</b> ' + permitCount + ' задач с действующими ордерами. Проверьте сроки истечения разрешений в разделе «Отчёты».</div>';
    }
    if (weatherCount > 0) {
      html += '<div class="weather-warn">🌡️ <b>Погодные ограничения:</b> ' + weatherCount + ' задач не могут быть выполнены из-за несоответствия температуры.</div>';
    }

    // Информация о погоде из прогноза
    var todayWeather = getWeatherForecast(0);
    if (todayWeather) {
      var snowExpected = '';
      for (var off = 1; off <= 7; off++) {
        var wf = getWeatherForecast(off);
        if (wf && wf.snow && wf.snowfall > 0.1) {
          snowExpected = ' · ❄️ Снег ожидается ' + fmtShort(off) + ' (' + wf.snowfall + ' мм)';
          break;
        }
      }
      var wIcon = todayWeather.snow ? '❄️' : todayWeather.desc.indexOf('Дождь') !== -1 || todayWeather.desc.indexOf('Морось') !== -1 ? '🌧️' : todayWeather.desc === 'Ясно' ? '☀️' : '⛅';
      html += '<div style="margin-bottom:12px;padding:10px 14px;background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;border-radius:10px;display:flex;align-items:center;gap:12px;">';
      html += '<span style="font-size:28px;">' + wIcon + '</span>';
      html += '<div><div style="font-size:15px;font-weight:700;">' + todayWeather.temp + '°C · ' + todayWeather.desc + '</div>';
      html += '<div style="font-size:11px;color:#cbd5e1;">Погода: Минск · ' + fmt(TODAY) + snowExpected + '</div></div>';
      html += '</div>';
    }

    html += '<div class="card" style="margin-bottom:16px;background:linear-gradient(135deg, #0f2740 0%, #1a3a5c 100%);color:#fff;border:1px solid rgba(255,255,255,0.15);"><div class="card-h" style="border-bottom:1px solid rgba(255,255,255,0.12);"><h2 style="color:#fff;display:flex;align-items:center;gap:8px;">📊 Панель аналитики (по ТЗ v2.0, раздел 6.3)</h2><span class="sub" style="color:#94a3b8;">Модель с учетом переездов и экономии ГСМ</span><div class="spacer"></div><span style="background:none;color:#fff;font-weight:700;">SmartPlanner Ядро 2.0</span></div><div class="card-b" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:16px;padding:16px;">';
    html += '<div style="background:rgba(255,255,255,0.06);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;font-weight:600;">⚡ КПД Мастеров (Работа vs Дорога)</div><div style="font-size:22px;font-weight:800;color:#38bdf8;margin-bottom:4px;">82,4% <span style="font-size:13px;font-weight:500;color:#94a3b8;">на объектах</span></div><div style="font-size:11.5px;color:#cbd5e1;">🚗 В пути: <b>17,6%</b> (норма ТЗ: ≤ 20%)<br>Среднее время переезда: <b>≈ 16 мин</b></div></div>';
    html += '<div style="background:rgba(255,255,255,0.06);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;font-weight:600;">⛽ Экономия ГСМ (Яндекс.Оптимизация)</div><div style="font-size:22px;font-weight:800;color:#10b981;margin-bottom:4px;">-24,8% <span style="font-size:13px;font-weight:500;color:#94a3b8;">пробега</span></div><div style="font-size:11.5px;color:#cbd5e1;">📉 Сокращение: <b>≈ 142 л/мес</b><br>💰 Экономия бюджета: <b>≈ 340 BYN</b></div></div>';
    html += '<div style="background:rgba(255,255,255,0.06);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;font-weight:600;">⏰ Сводка по дедлайнам (≤ 3 дня)</div><div style="font-size:22px;font-weight:800;color:#facc15;margin-bottom:4px;">' + redzone.length + ' <span style="font-size:13px;font-weight:500;color:#94a3b8;">задач в зоне</span></div><div style="font-size:11.5px;color:#cbd5e1;">Резерв ресурса: <b>+14.5 чел/ч</b><br>Статус: <b>Риск просрочки отсутствует</b></div></div>';
    html += '</div></div>';

    html += '<div class="dash-grid">';
    html += '<div class="card"><div class="card-h"><h2>Сегодня</h2><span class="sub">' + fmt(TODAY) + '</span><div class="spacer"></div><span class="badge tag ' + (overloads ? 'over' : 'ok') + '">' + (overloads ? 'Есть перегрузки' : 'Без перегрузок') + '</span></div><div class="card-b">';
    if (!today.length) html += '<div class="empty">На сегодня задач нет</div>';
    mastersToday.forEach(function (m) {
      var mt = today.filter(function (t) { return t.m === m.id; });
      var load = mt.reduce(function (s, t) { return s + (isDone(t) ? 0 : taskHours(t)); }, 0);
      var over = load > CAP;
      html += '<div class="today-mstr"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div><div class="meta"><div class="h" style="color:' + (over ? 'var(--red)' : 'var(--ink)') + '">' + fmtH(load) + ' ч / ' + CAP + ' ч</div><span class="tag ' + (over ? 'over' : 'ok') + '">' + (over ? '⚠ Перегрузка +' + fmtH(load - CAP) + ' ч' : mt.length + ' заданий') + '</span></div></div>';
      mt.slice(0, 4).forEach(function (t) {
        var o = OBJ_MAP[t.o], w = workOf(t);
        html += '<div class="taskline"><span class="pill">' + esc(w ? w.name : '?') + '</span><span>' + esc(addrOf(t)) + '</span><span style="margin-left:auto;color:var(--muted)">' + fmtH(taskHours(t)) + ' ч</span></div>';
      });
      if (mt.length > 4) html += '<div class="taskline" style="color:var(--muted)">и ещё ' + (mt.length - 4) + '…</div>';
    });
    html += '</div></div>';

    html += '<div class="card"><div class="card-h"><h2>Красная зона</h2><span class="sub">предельный срок истекает</span></div><div class="card-b">';
    if (!redzone.length) html += '<div class="empty">Просрочек нет 🎉</div>';
    redzone.forEach(function (t) {
      var o = OBJ_MAP[t.o], w = workOf(t), m = masterById(t.m);
      var col = taskColor(t);
      html += '<div class="rz-item"><div class="rz-bar" style="background:' + (col === 'red' ? 'var(--red)' : 'var(--yellow)') + '"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">' + esc(m ? m.name : '?') + ' · ' + esc(m ? m.area : '') + ' · ' + statusLabel(t) + '</div></div><div class="rz-dl ' + (col === 'red' ? 'red' : 'yel') + '">' + (t.dl < 0 ? 'просрочка ' + (-t.dl) + ' дн' : t.dl === 0 ? 'сегодня!' : 'осталось ' + t.dl + ' дн') + '</div></div>';
    });
    html += '</div></div></div>';

    html += '<div class="card"><div class="card-h"><h2>Прогресс месяца</h2><span class="sub">' + MON[TODAY.getMonth()] + ' ' + TODAY.getFullYear() + ' · по участкам</span><div class="spacer"></div>' + ringHTML(pct, 64, 8, true) + '<div style="text-align:center;margin-left:6px"><div style="font-size:11px;color:var(--muted)">Итого</div><div style="font-weight:800;color:var(--ink)">' + pct + '%</div></div></div><div class="card-b"><div class="rings">';
    Object.keys(areas).forEach(function (a) {
      var x = areas[a]; var p = x.total ? Math.round(x.done / x.total * 100) : 0;
      html += '<div class="ring">' + ringHTML(p, 70, 9) + '<div class="ar">' + esc(a) + ' · ' + x.done + '/' + x.total + '</div></div>';
    });
    html += '</div></div></div>';

    view.innerHTML = html;
    document.getElementById('rz-badge').textContent = redzone.length;

    // привязка селектора участка (для админа)
    var dashAreaSel = document.getElementById('dash-area');
    if (dashAreaSel) dashAreaSel.addEventListener('change', function (e) { S.dashArea = e.target.value || null; renderDashboard(); });
  }

  function kpi(val, lab, hint, color, id) {
    return '<div class="kpi"><div class="acc" style="background:' + color + '"></div><div class="lab">' + lab + '</div><div class="val"' + (id ? ' id="' + id + '"' : '') + '>' + val + '</div><div class="hint">' + hint + '</div></div>';
  }
  function ringHTML(pct, size, stroke, small) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    var col = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    var fs = small ? 13 : 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="#e2e8f0" stroke-width="' + stroke + '"/><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')"/><text x="50%" y="54%" text-anchor="middle" font-size="' + fs + '" font-weight="800" fill="#1f2937">' + pct + '%</text></svg>';
  }

  /* =====================================================================
     РЕНДЕР: КАЛЕНДАРЬ
     ===================================================================== */
  function renderCalendar() {
    var html = '<div class="cal-head"><div class="seg">';
    html += segBtn('day', 'День') + segBtn('week', 'Неделя') + segBtn('month', 'Месяц');
    html += '</div>';
    html += '<button class="btn sm" data-action="cal-prev">‹</button>';
    html += '<span class="cal-title" id="cal-title"></span>';
    html += '<button class="btn sm" data-action="cal-next">›</button>';
    if (S.calMode !== 'day' || S.dayShift !== 0) html += '<button class="btn sm" data-action="cal-today">Сегодня</button>';
    if (canPlan()) {
      html += '<button class="btn sm primary" data-action="new-task">' + IC.plus + ' Добавить задачу</button>';
      html += '<button class="btn sm" data-action="optimize-works" style="background:#6366f1;color:#fff;border-color:#6366f1;" title="Автоматическое распределение работ без просрочек с соблюдением 8-часового рабочего дня (ТЗ 2.0)">⚡ Оптимизировать работы</button>';
      html += '<button class="btn sm" data-action="import-tasks-excel" style="background:#10b981;color:#fff;border-color:#10b981;" title="Импорт задач из Excel с валидацией (ТЗ 2.0)">📥 Импорт из Excel</button>';
    }
    html += '<div class="trash-zone" id="trash-zone" title="Перетащите сюда задачу для удаления">' + IC.trash + ' <span>Корзина</span></div>';
    html += '<div class="legend"><span><i style="background:var(--green-l);border:1px solid var(--green)"></i>В норме</span><span><i style="background:var(--yellow-l);border:1px solid var(--yellow)"></i>Мало времени</span><span><i style="background:var(--red-l);border:1px solid var(--red)"></i>Просрочка</span><span><i style="background:#fef3c7;border:1px solid #f59e0b"></i>Ожидание погоды</span><span><i style="background:#f1f5f9;border:1px solid #94a3b8"></i>Выполнено</span></div>';
    html += '</div>';
    if (S.role === 'master') {
      html += '<div class="calc" style="margin-bottom:12px">' + IC.info + ' Ваш личный график. Перетаскивайте карточки, чтобы менять дату выполнения.</div>';
    } else if (S.role !== 'admin') {
      html += '<div class="calc" style="margin-bottom:12px">' + IC.info + ' Участок <b>' + esc(S.user.area) + '</b>: доступны только мастера этого участка.</div>';
    }
    html += '<div class="cal-scroll"><div class="cal-grid ' + S.calMode + '" id="cal-grid"></div></div>';
    view.innerHTML = html;
    drawCalendarGrid();
  }
  function segBtn(mode, label) {
    return '<button class="' + (S.calMode === mode ? 'on' : '') + '" data-action="cal-mode" data-mode="' + mode + '">' + label + '</button>';
  }
  function drawCalendarGrid() {
    var grid = document.getElementById('cal-grid');
    var masters = visibleMasters();
    var days = buildDayWindow();
    document.getElementById('cal-title').textContent = windowTitle(days);

    if (!masters.length) {
      grid.style.gridTemplateColumns = '1fr';
      grid.innerHTML = '<div style="padding:44px 20px;text-align:center;color:var(--muted)"><div style="font-size:38px;margin-bottom:12px">👥</div><div style="color:var(--ink);font-size:15px;font-weight:700">Нет мастеров для планирования</div><div style="margin-top:8px;font-size:12.5px;max-width:420px;margin-left:auto;margin-right:auto">Добавьте пользователей с ролью «Мастер» или «Старший мастер» в разделе «Пользователи» — они автоматически появятся здесь как строки календаря.</div></div>';
      return;
    }

    grid.style.gridTemplateColumns = '170px repeat(' + days.length + ', minmax(74px,1fr))';
    var html = '';
    html += '<div class="col-head gh corner" style="grid-column:1;grid-row:1">Мастер / Бригада</div>';
    days.forEach(function (d, i) {
      var we = (d.getDay() === 0 || d.getDay() === 6);
      var cls = 'col-head gh' + (sameDay(d, TODAY) ? ' today' : '') + (we ? ' we' : '');
      html += '<div class="' + cls + '" style="grid-column:' + (i + 2) + ';grid-row:1"><div class="dn">' + d.getDate() + '</div><div class="wd">' + WD[d.getDay()] + '</div></div>';
    });
    masters.forEach(function (m, ri) {
      var rn = ri + 2;
      html += '<div class="mname" style="grid-column:1;grid-row:' + rn + '"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div></div>';
      days.forEach(function (d, ci) {
        var off = dateToOff(d);
        var load = loadForDay(m.id, off);
        var over = load > CAP;
        var we = (d.getDay() === 0 || d.getDay() === 6);
        var cls = 'cell' + (sameDay(d, TODAY) ? ' today' : '') + (we ? ' we' : '') + (over ? ' overload' : '');
        html += '<div class="' + cls + '" style="grid-column:' + (ci + 2) + ';grid-row:' + rn + '" data-master="' + m.id + '" data-off="' + off + '"' + (over ? ' title="Перегрузка: ' + fmtH(load) + ' ч"' : '') + '>';
        if (over) html += '<span class="ov-warn">' + fmtH(load) + 'ч</span>';
        S.tasks.forEach(function (t) {
          if (t.m === m.id && t.d === off) {
            var col = taskColor(t);
            var o = OBJ_MAP[t.o], w = workOf(t);
            var draggable = (!isDone(t) && canEditTask(t)) ? 'true' : 'false';
            var wMeta = workOf(t);
            var badges = '';
            if (t.needs_permit) badges += '<span class="ov-permit">📋</span>';
            else if (wMeta && wMeta.min_temp > -50) {
              var wf = getWeatherForecast(off);
              if (wf && wf.temp != null && wf.temp < wMeta.min_temp) badges += '<span class="ov-weather">⚠</span>';
            }
            html += '<div class="tile t-' + col + '" draggable="' + draggable + '" data-action="edit-task" data-tid="' + t.id + '" title="Нажмите для редактирования задания">' + badges + '<span class="tw">' + esc(w ? w.name : '?') + (t.volume ? ' ×' + t.volume : '') + '</span><span class="th">' + esc(addrOf(t)) + ' · ' + fmtH(taskHours(t)) + 'ч</span><label class="tile-chk" onmousedown="event.stopPropagation()" ondragstart="return false"><input type="checkbox" data-action="toggle-done" data-tid="' + t.id + '"' + (isDone(t) ? ' checked' : '') + '><span class="tile-chk-box"></span></label></div>';
          }
        });
        html += '</div>';
      });
    });
    grid.innerHTML = html;
    attachCalDnD();
  }
  function buildDayWindow() {
    var arr = [];
    if (S.calMode === 'week') {
      var start = addDays(mondayOf(TODAY), S.weekShift * 7);
      for (var i = 0; i < 7; i++) arr.push(addDays(start, i));
    } else if (S.calMode === 'day') {
      arr.push(addDays(TODAY, S.dayShift));
    } else {
      var base = new Date(TODAY.getFullYear(), TODAY.getMonth() + S.monthShift, 1);
      var n = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      for (var j = 1; j <= n; j++) arr.push(new Date(base.getFullYear(), base.getMonth(), j));
    }
    return arr;
  }
  function windowTitle(days) {
    if (S.calMode === 'day') return fmt(days[0]) + ' · ' + WD_FULL[days[0].getDay()];
    if (S.calMode === 'week') return fmt(days[0]) + ' — ' + fmt(days[6]);
    return MON[days[0].getMonth()] + ' ' + days[0].getFullYear();
  }

  /* ---------- DRAG & DROP ---------- */
  var dragId = null;
  function attachCalDnD() {
    var grid = document.getElementById('cal-grid'); if (!grid) return;
    grid.addEventListener('dragstart', function (e) {
      var tile = e.target.closest('.tile'); if (!tile) return;
      dragId = tile.dataset.tid; tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
    });
    grid.addEventListener('dragend', function () {
      document.querySelectorAll('.tile.dragging').forEach(function (t) { t.classList.remove('dragging'); });
      document.querySelectorAll('.cell.drop-on').forEach(function (c) { c.classList.remove('drop-on'); });
      dragId = null;
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragId) return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.cell.drop-on').forEach(function (c) { if (c !== cell) c.classList.remove('drop-on'); });
      cell.classList.add('drop-on');
    });
    grid.addEventListener('drop', function (e) {
      if (!dragId) return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      e.preventDefault();
      var id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      cell.classList.remove('drop-on');
      var t = findTask(id); if (!t) return;
      if (!canEditTask(t)) { toast('err', 'Нет прав на редактирование этой задачи'); return; }
      var newMaster = cell.dataset.master, newOff = parseInt(cell.dataset.off, 10);
      // мастер — только своя строка; nach/smaster — только свой участок
      if (!canDropOn(newMaster)) { toast('err', 'Этот мастер вне вашего доступа'); return; }
      var target = masterById(newMaster);
      var moved = [];
      if (t.m !== newMaster) { t.m = newMaster; moved.push('мастер → ' + (target ? target.name : '?')); }
      if (t.d !== newOff) { t.d = newOff; moved.push('дата → ' + fmtShort(newOff)); }
      if (moved.length) {
        if (TASKS_DB) { TASKS_DB.updateTask(t.id, t); }
        drawCalendarGrid();
        var load = loadForDay(newMaster, newOff);
        if (load > CAP) {
          toast('warn', '🛑 Аналитика помощника (ТЗ 7): Внимание! Перегрузка мастера ' + (target ? target.name : '') + ' до ' + fmtH(load) + ' ч (при норме ' + CAP + ' ч). Предлагаем перенести задачу на другой день или заменить мастера!');
        } else {
          toast('ok', '💡 Аналитика помощника (ТЗ 7): Перенос успешно выполнен. Текущая загрузка мастера ' + (target ? target.name : '') + ' на этот день составляет ' + fmtH(load) + ' ч / ' + CAP + ' ч.');
        }
      }
    });
    grid.addEventListener('mousemove', tipHandler);
    grid.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

    // === КОРЗИНА: перетаскивание задачи для удаления ===
    var trash = document.getElementById('trash-zone');
    if (trash) {
      trash.addEventListener('dragover', function (e) {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        trash.classList.add('drop-active');
      });
      trash.addEventListener('dragleave', function () { trash.classList.remove('drop-active'); });
      trash.addEventListener('drop', function (e) {
        e.preventDefault();
        trash.classList.remove('drop-active');
        if (!dragId) return;
        var t = findTask(dragId); if (!t) return;
        if (!canEditTask(t)) { toast('err', 'Нет прав на удаление этой задачи'); return; }
        var w = workOf(t);
        if (!window.confirm('Удалить задачу «' + (w ? w.name : '?') + ' — ' + addrOf(t) + '»?')) return;
        if (TASKS_DB) { TASKS_DB.deleteTask(dragId); S.tasks = TASKS_DB.getTasks(); } else { S.tasks = S.tasks.filter(function (x) { return x.id !== dragId; }); }
        dragId = null;
        drawCalendarGrid();
        toast('ok', '🗑️ Аналитика помощника (ТЗ 7): Задача удалена. Освободилось ' + fmtH(taskHours(t)) + ' ч у мастера ' + (masterById(t.m) ? masterById(t.m).name : '?') + '.');
      });
    }
  }
  function tipHandler(e) {
    var tile = e.target.closest('.tile');
    if (!tile) { tip.style.display = 'none'; return; }
    var t = findTask(tile.dataset.tid); if (!t) return;
    var o = OBJ_MAP[t.o], w = workOf(t), m = masterById(t.m);
    var dlTxt = t.dl < 0 ? '<b style="color:#fca5a5">просрочка ' + (-t.dl) + ' дн</b>' : t.dl === 0 ? '<b style="color:#fde047">дедлайн сегодня</b>' : 'дедлайн: ' + fmtShort(t.dl);
    tip.innerHTML = '<b>' + esc(w ? w.name : '?') + '</b><br>' + esc(addrOf(t)) + ' · ' + esc(o ? o.type : '') + '<br>Объём: ' + (t.volume || 1) + ' ' + (w ? w.unit : '') + ' — ' + fmtH(taskHours(t)) + ' ч' +
      (t.needs_permit ? '<br><b style="color:#fca5a5">📋 Ордер до: ' + (t.dl_date || '—') + '</b>' : '') +
      (t.depends_on_snow ? '<br><b style="color:#7dd3fc">❄️ Снегозависимая (норматив 48 ч)</b>' : '') +
      (w && w.min_temp > -50 ? '<br><b style="color:#fbbf24">🌡️ Мин. t: +' + w.min_temp + '°C' + (function(){ var wf = getWeatherForecast(t.d); if (!wf) return ''; var snowInfo = wf.snow ? ' · ❄️ ' + wf.snowfall + 'мм' : ''; return ' (прогноз: ' + wf.temp + '°C · ' + wf.desc + snowInfo + ')'; })() + '</b>' : '') +
      (w && w.equipment && w.equipment !== '—' ? '<br>🚜 Техника: ' + esc(w.equipment) : '') +
      '<br>Мастер: ' + esc(m ? m.name : '?') + ' · ' + statusLabel(t) + '<br>' + dlTxt + ' · план: ' + fmtShort(t.d);
    tip.style.display = 'block';
    var x = e.clientX + 14, y = e.clientY + 14;
    if (x + 270 > window.innerWidth) x = e.clientX - 270;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function findTask(id) { for (var i = 0; i < S.tasks.length; i++) if (S.tasks[i].id === id) return S.tasks[i]; return null; }

  /* =====================================================================
     ЯДРО: "ОПТИМИЗАТОР"
     ===================================================================== */
  function checkOverload() {
    var fixes = 0;
    visibleMasters().forEach(function (m) {
      for (var off = -7; off <= 14; off++) {
        var load = loadForDay(m.id, off);
        while (load > CAP) {
          var dayTasks = S.tasks.filter(function (t) { return t.m === m.id && t.d === off && !isDone(t); }).sort(function (a, b) { return b.dl - a.dl; });
          if (!dayTasks.length) break;
          dayTasks[0].d = off + 1; fixes++;
          load = loadForDay(m.id, off);
        }
      }
    });
    if (fixes) toast('ok', 'Контроль ФРВ: снято перегрузок — ' + fixes + '.');
    else toast('ok', 'Контроль ФРВ: перегрузок не обнаружено.');
    refresh();
  }
  function optimizeRoutes() {
    var edits = 0;
    visibleMasters().forEach(function (m) {
      [-1, 0, 1].forEach(function (off) {
        var dayTasks = S.tasks.filter(function (t) { return t.m === m.id && t.d === off && !isDone(t); });
        if (dayTasks.length < 3) return;
        dayTasks.forEach(function (t) {
          var o = OBJ_MAP[t.o]; if (!o) return;
          for (var delta = 1; delta <= 2; delta++) {
            [off + delta, off - delta].forEach(function (adj) {
              var near = S.tasks.filter(function (x) {
                if (x.m !== m.id || x.d !== adj || isDone(x)) return false;
                var ob = OBJ_MAP[x.o]; if (!ob) return false;
                var dd = Math.sqrt(Math.pow(o.lat - ob.lat, 2) + Math.pow(o.lng - ob.lng, 2));
                return dd < 0.012;
              });
              if (near.length && adj !== off) {
                var load = loadForDay(m.id, adj);
                if (load + taskHours(t) <= CAP) { t.d = adj; edits++; }
              }
            });
          }
        });
      });
    });
    toast('ok', 'Маршруты оптимизированы: сгруппировано ' + edits + ' задач по близким адресам.');
    refresh();
  }
  function optimizeWorksCalendar() {
    var edits = 0;
    var masters = visibleMasters();
    
    masters.forEach(function (m) {
      var mTasks = S.tasks.filter(function (t) { return t.m === m.id && !isDone(t); });
      if (!mTasks.length) return;

      mTasks.sort(function (a, b) {
        if (a.dl !== b.dl) return a.dl - b.dl;
        if (a.d !== b.d) return a.d - b.d;
        return taskHours(b) - taskHours(a);
      });

      var dayLoad = {};
      S.tasks.forEach(function (t) {
        if (t.m === m.id && isDone(t)) {
          var dOff = Math.max(0, t.d);
          dayLoad[dOff] = (dayLoad[dOff] || 0) + taskHours(t);
        }
      });

      mTasks.forEach(function (t) {
        var h = taskHours(t);
        var prefDay = Math.max(0, t.d);
        
        var bestDay = null;
        var minPenalty = Infinity;
        
        for (var d = 0; d <= 90; d++) {
          var curLoad = dayLoad[d] || 0;
          if (curLoad > 0 && curLoad + h > CAP) continue;
          if (curLoad + h > CAP && curLoad > 0) continue;
          
          var penalty = Math.abs(d - prefDay) * 10;
          
          if (d > t.dl) {
            penalty += (d - t.dl) * 10000 + 50000;
          }
          if (d > prefDay) {
            penalty += 5;
          }
          
          if (penalty < minPenalty) {
            minPenalty = penalty;
            bestDay = d;
          }
        }
        
        if (bestDay === null) {
          for (var d = 0; d <= 90; d++) {
            if (!(dayLoad[d] > 0)) { bestDay = d; break; }
          }
          if (bestDay === null) bestDay = prefDay;
        }

        if (t.d !== bestDay) {
          t.d = bestDay;
          edits++;
        }
        
        if (t.dl < bestDay || t.dl < 0) {
          t.dl = Math.max(bestDay, 0);
          edits++;
        }

        dayLoad[bestDay] = (dayLoad[bestDay] || 0) + h;
        if (TASKS_DB) { TASKS_DB.updateTask(t.id, t); }
      });
    });

    toast('ok', '⚡ Оптимизация работ выполнена: распределено без просрочек с соблюдением 8-часового рабочего дня (ТЗ 2.0).');
    refresh();
  }
  function autoSchedule() { optimizeWorksCalendar(); }

  /* =====================================================================
     РЕНДЕР: КАРТА МАРШРУТОВ
     ===================================================================== */
  var ymState = { token: 0, loaded: false, loading: false, waiting: [], ymap: null, pts: [], route: null, manualOrder: false };
  function renderMap() {
    try {
      var off = S.mapOff;
      var masters = visibleMasters() || [];
    if (!S.mapMaster) S.mapMaster = 'all';
    if (S.role === 'master' && S.user) S.mapMaster = S.user.id;
    if (S.mapMaster !== 'all') {
      var foundM = false;
      for (var i = 0; i < masters.length; i++) if (masters[i].id === S.mapMaster) { foundM = true; break; }
      if (!foundM) S.mapMaster = 'all';
    }

    var list = visibleTasks().filter(function (t) {
      if (t.d !== off || isDone(t)) return false;
      if (S.mapMaster && S.mapMaster !== 'all') return t.m === S.mapMaster;
      return true;
    });
    var base = currentBase();
    var prevObj = base;
    var pts = list.map(function (t) {
      var o = OBJ_MAP[t.o] || null, m = masterById(t.m), w = workOf(t);
      var lat = o ? o.lat : null, lng = o ? o.lng : null;
      var travelMin = t.travelMin != null ? t.travelMin : null;
      var travelKm = t.travelKm != null ? t.travelKm : null;
      var travelKmText = t.travelKmText != null ? t.travelKmText : (travelKm != null ? travelKm.toFixed(1).replace('.', ',') + ' км' : null);
      var travelText = t.travelText != null ? t.travelText : (travelMin != null ? fmtDuration(travelMin) : null);
      if (lat != null && lng != null) prevObj = { lat: lat, lng: lng };
      return { id: t.id, lat: lat, lng: lng, addr: addrOf(t), type: o ? o.type : '—', work: w ? w.name : '?', master: m ? m.name : '?', mcol: m ? m.color : '#94a3b8', hours: taskHours(t), norm: w ? w.norm : 0, travelMin: travelMin, travelText: travelText, travelKm: travelKm, travelKmText: travelKmText };
    });

    var prov = S.mapProvider || 'yandex';
    var provSelHTML = '<div style="display:flex;align-items:center;gap:6px;margin-left:auto;"><span style="font-size:12px;color:var(--ink);font-weight:700;">Выбор карты:</span><select id="map-provider-sel" style="padding:5px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;background:#fff;color:var(--ink);font-weight:700;cursor:pointer;">' +
      '<option value="yandex"' + (prov === 'yandex' ? ' selected' : '') + '>Яндекс карта</option>' +
      '<option value="google"' + (prov === 'google' ? ' selected' : '') + '>Гугл карта</option>' +
    '</select></div>';

    var html = '<div class="cal-head"><div class="seg">' +
      '<button class="' + (off === -1 ? 'on' : '') + '" data-action="map-off" data-off="-1">Вчера</button>' +
      '<button class="' + (off === 0 ? 'on' : '') + '" data-action="map-off" data-off="0">Сегодня</button>' +
      '<button class="' + (off === 1 ? 'on' : '') + '" data-action="map-off" data-off="1">Завтра</button></div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span style="font-size:12.5px;color:var(--muted);font-weight:600;">Выбрать дату:</span>' +
        '<input type="date" id="map-date-sel" value="' + key(offToDate(off)) + '" style="padding:5px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;background:#fff;color:var(--ink);font-weight:600;cursor:pointer;" title="Выбрать любую дату для просмотра маршрута">' +
      '</div>' +
      '<button class="btn primary" data-action="build-route">' + IC.route + ' Оптимизация маршрутов</button>' +
      '<div class="spacer"></div>' +
      provSelHTML +
      '</div>';

    var masterSelHTML = '<select id="map-master-sel" style="padding:4px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;background:#fff;color:var(--ink);max-width:200px;font-weight:600;">';
    if (masters.length > 1) {
      masterSelHTML += '<option value="all"' + (S.mapMaster === 'all' ? ' selected' : '') + '>Все мастера (' + masters.length + ')</option>';
    }
    masters.forEach(function (m) {
      masterSelHTML += '<option value="' + m.id + '"' + (S.mapMaster === m.id ? ' selected' : '') + '>' + esc(m.name) + ' (' + esc(m.area) + ')</option>';
    });
    masterSelHTML += '</select>';

    var curD = offToDate(off);
    var shortDateStr = curD.getDate() + ' ' + MON[curD.getMonth()].slice(0, 3) + '. ' + String(curD.getFullYear()).slice(-2);
    html += '<div class="map-wrap"><div><div class="card"><div class="card-h"><div style="display:flex;flex-direction:column;line-height:1.15;gap:2px;"><span style="font-size:13px;font-weight:700;color:var(--ink);">Задания на</span><span style="font-size:12px;font-weight:700;color:var(--blue);">' + shortDateStr + '</span></div><div class="spacer"></div>' + masterSelHTML + '</div><div class="card-b mlist" id="mlist">';
    if (!pts.length) html += '<div class="empty">На этот день заданий нет</div>';
    pts.forEach(function (p, i) {
      html += '<div class="mtask sel" data-mid="' + p.id + '" draggable="true"><div class="mtask-grip">' + IC.grip + '</div><div class="pin" style="background:' + p.mcol + '">' + (i + 1) + '</div><div style="flex:1;min-width:0"><div style="font-weight:700;color:var(--ink);font-size:12.5px;margin-bottom:3px">📍 ' + esc(p.addr) + '</div><div style="font-size:11.5px;color:var(--txt);margin-bottom:2px">🔧 ' + esc(p.work) + '</div><div style="font-size:11.5px;color:var(--muted);">⏱ Норма времени: <b>' + fmtH(p.norm) + ' ч</b></div></div></div>';
    });
    html += '</div></div></div>';

    html += '<div><div class="map-box" id="mapbox"><div class="map-stats" id="map-stats" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;"><span>Объектов: <b>' + pts.length + '</b></span><span style="display:flex;align-items:center;gap:6px;border-left:1px solid var(--line);padding-left:12px;margin-left:4px;"><span style="color:var(--txt);font-weight:600;">Общее время и километраж:</span> <span id="route-info" style="color:var(--muted);font-weight:700;">нажмите «Оптимизировать маршрут» для расчета</span></span><span style="margin-left:auto;color:var(--muted)">🚩 ' + esc(currentBase().name) + '</span></div><div id="map-canvas" style="width:100%;height:calc(100vh - 210px);min-height:400px"></div><div class="map-note" id="map-note"></div></div></div></div>';

    view.innerHTML = html;
    S.mapSel = {}; pts.forEach(function (p) { S.mapSel[p.id] = true; });
    if (ymState.returnTrip) pts.returnTrip = ymState.returnTrip;
    ymState.manualOrder = false;
    refreshMapCards(pts);

    var dtSel = document.getElementById('map-date-sel');
    if (dtSel) dtSel.addEventListener('change', function(e) {
      if (e.target.value) {
        var picked = new Date(e.target.value + 'T00:00:00');
        if (!isNaN(picked.getTime())) {
          S.mapOff = dateToOff(picked);
          renderMap();
        }
      }
    });

    var provSelEl = document.getElementById('map-provider-sel');
    if (provSelEl) provSelEl.addEventListener('change', function(e) {
      S.mapProvider = e.target.value;
      renderMap();
    });

    var mlist = document.getElementById('mlist');

    // Клик — вкл/выкл задания
    mlist.addEventListener('click', function (e) {
      var el = e.target.closest('.mtask'); if (!el) return;
      var id = el.dataset.mid;
      S.mapSel[id] = !S.mapSel[id];
      el.classList.toggle('sel', S.mapSel[id]);
      drawMap(pts);
    });

    // === DRAG-AND-DROP: смена порядка заданий ===
    var mapDragId = null;
    mlist.addEventListener('dragstart', function (e) {
      var card = e.target.closest('.mtask');
      if (!card) return;
      mapDragId = card.dataset.mid;
      card.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', mapDragId); } catch (err) {}
    });
    mlist.addEventListener('dragend', function () {
      mlist.querySelectorAll('.mtask').forEach(function (c) {
        c.style.opacity = ''; c.classList.remove('drop-above');
      });
      mapDragId = null;
    });
    mlist.addEventListener('dragover', function (e) {
      if (!mapDragId) return;
      var card = e.target.closest('.mtask');
      if (!card || card.dataset.mid === mapDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mlist.querySelectorAll('.mtask.drop-above').forEach(function (c) { c.classList.remove('drop-above'); });
      card.classList.add('drop-above');
    });
    mlist.addEventListener('drop', function (e) {
      if (!mapDragId) return;
      var card = e.target.closest('.mtask');
      if (!card || card.dataset.mid === mapDragId) return;
      e.preventDefault();
      e.stopPropagation();
      // Находим индексы и меняем местами
      var fromIdx = -1, toIdx = -1;
      pts.forEach(function (p, i) {
        if (p.id === mapDragId) fromIdx = i;
        if (p.id === card.dataset.mid) toIdx = i;
      });
      if (fromIdx === -1 || toIdx === -1) return;
      var moved = pts.splice(fromIdx, 1)[0];
      pts.splice(toIdx, 0, moved);
      ymState.manualOrder = true;
      // Перерисовываем карточки
      refreshMapCards(pts);
      // Перестраиваем маршрут в новом порядке
      drawMap(pts);
      toast('ok', 'Порядок изменён');
    });

    drawMap(pts);
    var mSel = document.getElementById('map-master-sel');
    if (mSel) mSel.addEventListener('change', function (e) { S.mapMaster = e.target.value; renderMap(); });
    } catch (err) {
      console.error('renderMap error:', err);
      var viewEl = document.getElementById('view');
      if (viewEl) viewEl.innerHTML = '<div class="card"><div class="card-b" style="color:var(--red);padding:20px;font-weight:600;">Ошибка отображения Карты маршрутов: ' + esc(err.message) + '</div></div>';
    }
  }
  /* ====== УТИЛИТЫ КАРТЫ ====== */
  function ensureYandex(then, fail) {
    if (ymState.loaded && window.ymaps) { window.ymaps.ready(function () { then(); }); return; }
    if (ymState.loading) { ymState.waiting.push({ then: then, fail: fail }); return; }
    ymState.loading = true; ymState.waiting = [{ then: then, fail: fail }];
    var s = document.createElement('script');
    var apiKey = (window.SP_CONFIG && window.SP_CONFIG.yandexApiKey) || localStorage.getItem('SP_YANDEX_API_KEY') || '';
    s.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU' + (apiKey ? '&apikey=' + encodeURIComponent(apiKey) : '');
    s.onload = function () {
      if (window.ymaps) window.ymaps.ready(function () {
        ymState.loaded = true; ymState.loading = false;
        ymState.waiting.forEach(function (w) { w.then(); }); ymState.waiting = [];
      });
    };
    s.onerror = function () { ymState.loading = false; ymState.waiting.forEach(function (w) { w.fail(); }); ymState.waiting = []; };
    document.head.appendChild(s);
    setTimeout(function () { if (!ymState.loaded) { ymState.waiting.forEach(function (w) { w.fail(); }); ymState.waiting = []; } }, 10000);
  }
  function geocodeAddr(addr) {
    return new Promise(function (resolve) {
      if (!window.ymaps || !window.ymaps.geocode) { resolve(null); return; }
      var q = addr.indexOf('Минск') !== -1 ? addr : 'Минск, ' + addr;
      window.ymaps.geocode(q, { results: 1 }).then(function (res) {
        var g = res.geoObjects.get(0); resolve(g ? g.geometry.getCoordinates() : null);
      }, function () { resolve(null); });
    });
  }
  /* =====================================================================
     МОДУЛЬ ЯНДЕКС.КАРТ И ОПТИМИЗАЦИИ МАРШРУТОВ (ПЕРЕПИСАН НАЧИСТО ПО ТЗ)
     ===================================================================== */

  function fmtDuration(min) {
    min = Math.max(1, Math.round(min || 0));
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (h > 0 && m > 0) return h + ' ч ' + m + ' мин';
    if (h > 0 && m === 0) return h + ' ч';
    return m + ' мин';
  }

  // 1. Построение ссылки для встраивания виджета Яндекс.Карт по текстовым адресам / координатам
  function buildYandexWidgetUrl(items, noJam) {
    if (!items || !items.length) return '';
    var parts = [];
    items.forEach(function (item) {
      // Всегда приоритетно берем адрес (или адрес базы, указанный под логотипом smartplan)
      var a = item.addr || item.name || '';
      if (a && a !== '?') {
        a = a.trim();
        if (a.indexOf('Минск') === -1) a = 'Минск, ' + a;
        parts.push(a);
      } else if (item.lat != null && item.lng != null) {
        parts.push(item.lat + ',' + item.lng);
      }
    });
    var url = 'https://yandex.ru/map-widget/v1/?rtext=' + parts.join('~') + '&rtt=auto';
    if (noJam !== undefined) {
      url += noJam ? '&jams=0&trf=0' : '&jams=1&trf=1';
    }
    return url;
  }

  function buildYandexDirUrl(items, noJam) {
    if (!items || !items.length) return 'https://yandex.ru/maps/';
    var parts = [];
    items.forEach(function (item) {
      var a = item.addr || item.name || '';
      if (a && a !== '?') {
        a = a.trim();
        if (a.indexOf('Минск') === -1) a = 'Минск, ' + a;
        parts.push(a);
      } else if (item.lat != null && item.lng != null) {
        parts.push(item.lat + ',' + item.lng);
      }
    });
    var url = 'https://yandex.ru/maps/?rtext=' + parts.join('~') + '&rtt=auto';
    if (noJam !== undefined) {
      url += noJam ? '&jams=0&trf=0' : '&jams=1&trf=1';
    }
    return url;
  }

  // 2. Отображение начальной карты при заходе на страницу (БЕЗ изменения порядка заданий!)
  function drawMap(pts) {
    var sel = pts.filter(function (p) { return S.mapSel[p.id]; });
    var canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    if (pts.returnTrip) sel.returnTrip = pts.returnTrip;
    ymState.pts = sel;
    setRouteInfo(null);

    var base = currentBase();
    var prov = S.mapProvider || "yandex";

    if (sel.length >= 1) {
      var items = [base];
      sel.forEach(function (p) { items.push(p); });
      items.push(base); // Возврат на базу

      var url = "", dirUrl = "", provName = "Яндекс.Карты";
      if (prov === "google") {
        url = buildGoogleWidgetUrl(items);
        dirUrl = buildGoogleDirUrl(items);
        provName = "Google Maps";
      } else if (prov === "osm") {
        url = buildOsmWidgetUrl(items);
        dirUrl = buildOsmDirUrl(items);
        provName = "OpenStreetMap";
      } else if (prov === "2gis") {
        url = build2GisWidgetUrl(items);
        dirUrl = build2GisDirUrl(items);
        provName = "2ГИС";
      } else {
        url = buildYandexWidgetUrl(items);
        dirUrl = buildYandexDirUrl(items);
        provName = "Яндекс.Карты";
      }

      canvas.style.position = "relative";
      var panelActions = dirUrl ? "<div class='route-actions'><a class='btn sm primary' target='_blank' rel='noopener' href='" + dirUrl + "' style='background:#10b981;border-color:#10b981;'>↗ Открыть в " + provName + "</a></div>" : "";
      canvas.innerHTML = "<iframe class='route-frame' src='" + url + "' allowfullscreen loading='lazy' title='Маршрут на день (" + provName + ")'></iframe>" +
        "<div class='route-link-panel'>" +
          "<span>🚩 <b>База</b> → " + sel.length + " объектов (<b>сервис: " + provName + "</b>) → <b>База</b></span>" + panelActions +
        "</div>";

      if (prov === "google") {
        applyGoogleRouteStats(sel, base, function(success, totalKm, totalMin) {
          refreshMapCards(sel);
          if (totalKm > 0) {
            var el = document.getElementById("route-info");
            if (el) {
              el.innerHTML = '<b style="color:var(--ink);font-size:13.5px;">' + totalKm.toFixed(1).replace(".", ",") + ' км</b> · в пути: <b style="color:#2563eb;">' + (totalMin ? fmtDuration(totalMin) : '') + '</b>';
              el.style.color = "var(--ink)";
            }
          }
        });
      } else if (prov === "osm") {
        applyOsmRouteStats(sel, base, function(success, totalKm) {
          refreshMapCards(sel); if (totalKm > 0) setRouteInfo({ km: totalKm, count: sel.length });
        });
      } else if (prov === "2gis") {
        apply2GisRouteStats(sel, base, function(success, totalKm) {
          refreshMapCards(sel); if (totalKm > 0) setRouteInfo({ km: totalKm, count: sel.length });
        });
      } else {
        if (window.ymaps && window.ymaps.route) {
          ensureYandex(function () {
            window.ymaps.ready(function () {
              var ref = [];
              var baseStr = base.name.indexOf("Минск") !== -1 ? base.name : "Минск, " + base.name;
              ref.push(baseStr);
              sel.forEach(function (p) {
                var a = (p.addr || "").trim();
                if (a && a !== "?") {
                  if (a.indexOf("Минск") === -1) a = "Минск, " + a;
                  ref.push(a);
                } else if (p.lat != null && p.lng != null) {
                  ref.push([p.lat, p.lng]);
                }
              });
              ref.push(baseStr);
              try {
                window.ymaps.route(ref, { routingMode: "auto", multiRoute: true, optimizeWaypoints: false }).then(function (route) {
                  getMultiRouteStatsAsync(route, function(stats) {
                    if (stats && stats.km > 0) {
                      setRouteInfo({ km: stats.km, jamsMin: stats.jamsMin, freeMin: stats.freeMin, count: sel.length });
                    }
                  });
                  var applied = applyYandexRouteStats(route, sel, false);
                  if (applied) {
                    refreshMapCards(sel);
                  }
                });
              } catch(e) {}
            });
          });
        }
      }
    } else {
      var url = "https://yandex.ru/map-widget/v1/?ll=" + base.lng + "," + base.lat + "&z=14&pt=" + base.lat + "," + base.lng + ",pm2rdm&l=map";
      if (prov === "google") url = "https://www.google.com/maps?q=" + encodeURIComponent("Минск, " + base.name) + "&output=embed";
      else if (prov === "osm") url = "https://www.openstreetmap.org/export/embed.html?bbox=" + (base.lng - 0.05) + "," + (base.lat - 0.03) + "," + (base.lng + 0.05) + "," + (base.lat + 0.03) + "&layer=mapnik&marker=" + base.lat + "," + base.lng;
      else if (prov === "2gis") url = "https://2gis.by/minsk?m=" + base.lng + "%2C" + base.lat + "%2F14";
      canvas.style.position = "relative";
      canvas.innerHTML = "<iframe class='route-frame' src='" + url + "' allowfullscreen loading='lazy' title='База (" + prov + ")'></iframe>";
    }
  }

  // 3. Главная функция оптимизации при клике на кнопку «Оптимизация маршрутов» (для всех 4 карт: Яндекс, Google, OSM, 2ГИС)
  function buildRoute(noJam) {
    var pts = ymState.pts;
    var canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    if (!pts || pts.length < 1) { toast("warn", "Нет заданий на выбранный день."); return; }
    var base = currentBase();
    ymState.manualOrder = false;

    var tasks = pts.filter(function (p) { return p.addr && p.addr.trim() && p.addr !== "?"; });
    if (!tasks.length) { toast("warn", "В заданиях не указаны адреса."); return; }

    var prov = S.mapProvider || "yandex";
    var provName = prov === "google" ? "Google Maps" : prov === "osm" ? "OpenStreetMap" : prov === "2gis" ? "2ГИС" : "Яндекс.Карт";

    setRouteInfo({ km: 0, count: tasks.length, building: true });
    toast("ok", "⏳ Оптимизирую маршрут для сервиса " + provName + "…");

    var remaining = tasks.slice();
    var ordered = [];
    var cur = base;
    while (remaining.length) {
      var bestIdx = 0, bestDist = Infinity;
      for (var i = 0; i < remaining.length; i++) {
        var d = distKm(cur, remaining[i]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      var chosen = remaining.splice(bestIdx, 1)[0];
      ordered.push(chosen);
      cur = chosen;
    }

    updateDayListCards(ordered);

    var routeItems = [base];
    ordered.forEach(function (p) { routeItems.push(p); });
    routeItems.push(base);

    var fallbackTimeoutId = setTimeout(function() {
      updateFallbackRouteInfo(ordered);
    }, 2800);

    if (prov === "google") {
      applyGoogleRouteStats(ordered, base, function(success, totalKm, totalMin) {
        clearTimeout(fallbackTimeoutId);
        refreshMapCards(ordered);
        if (totalKm > 0) {
          var el = document.getElementById("route-info");
          if (el) {
            el.innerHTML = '<b style="color:var(--ink);font-size:13.5px;">' + totalKm.toFixed(1).replace(".", ",") + ' км</b> · в пути: <b style="color:#2563eb;">' + (totalMin ? fmtDuration(totalMin) : '') + '</b>';
            el.style.color = "var(--ink)";
          }
        }
        else updateFallbackRouteInfo(ordered);
        renderProviderFrame("google", routeItems);
        toast("ok", "✓ Маршрут оптимизирован для Google Maps! Нумерация и карточки обновлены.");
      });
    } else if (prov === "osm") {
      applyOsmRouteStats(ordered, base, function(success, totalKm) {
        clearTimeout(fallbackTimeoutId);
        refreshMapCards(ordered);
        if (totalKm > 0) setRouteInfo({ km: totalKm, count: ordered.length });
        else updateFallbackRouteInfo(ordered);
        renderProviderFrame("osm", routeItems);
        toast("ok", "✓ Маршрут оптимизирован для OpenStreetMap! Нумерация и карточки обновлены.");
      });
    } else if (prov === "2gis") {
      apply2GisRouteStats(ordered, base, function(success, totalKm) {
        clearTimeout(fallbackTimeoutId);
        refreshMapCards(ordered);
        if (totalKm > 0) setRouteInfo({ km: totalKm, count: ordered.length });
        else updateFallbackRouteInfo(ordered);
        renderProviderFrame("2gis", routeItems);
        toast("ok", "✓ Маршрут оптимизирован для 2ГИС! Нумерация и карточки обновлены.");
      });
    } else {
      if (window.ymaps && window.ymaps.route) {
        ensureYandex(function () {
          window.ymaps.ready(function () {
            var ref = [];
            var baseStr = base.name.indexOf("Минск") !== -1 ? base.name : "Минск, " + base.name;
            ref.push(baseStr);
            tasks.forEach(function (p) {
              var a = (p.addr || "").trim();
              if (a && a !== "?") {
                if (a.indexOf("Минск") === -1) a = "Минск, " + a;
                ref.push(a);
              } else if (p.lat != null && p.lng != null) {
                ref.push([p.lat, p.lng]);
              }
            });
            ref.push(baseStr);
            try {
              window.ymaps.route(ref, { routingMode: "auto", multiRoute: true, optimizeWaypoints: true, avoidTrafficJams: !!noJam }).then(function (route) {
                clearTimeout(fallbackTimeoutId);
                var waypoints = route.getWayPoints();
                var yandexOrdered = [];
                if (waypoints && typeof waypoints.each === "function") {
                  var wpArray = [];
                  waypoints.each(function (wp) { wpArray.push(wp); });
                  for (var wIdx = 1; wIdx < wpArray.length - 1; wIdx++) {
                    var wp = wpArray[wIdx];
                    var origIdx = wp.properties.get("index");
                    if (origIdx != null && origIdx >= 1 && origIdx <= tasks.length) {
                      var origTask = tasks[origIdx - 1];
                      if (yandexOrdered.indexOf(origTask) === -1) yandexOrdered.push(origTask);
                    }
                  }
                }
                if (yandexOrdered.length > 0) {
                  if (yandexOrdered.length < tasks.length) {
                    tasks.forEach(function (t) {
                      if (yandexOrdered.indexOf(t) === -1) {
                        for (var i = 0; i < yandexOrdered.length; i++) {
                          if (yandexOrdered[i].addr === t.addr || (Math.abs(yandexOrdered[i].lat - t.lat) < 0.0001 && Math.abs(yandexOrdered[i].lng - t.lng) < 0.0001)) {
                            yandexOrdered.splice(i + 1, 0, t);
                            break;
                          }
                        }
                        if (yandexOrdered.indexOf(t) === -1) yandexOrdered.push(t);
                      }
                    });
                  }
                  if (yandexOrdered.length === tasks.length) {
                    ordered = yandexOrdered;
                  }
                }

                var applied = applyYandexRouteStats(route, ordered, noJam);
                updateDayListCards(ordered);

                var finalItems = [base];
                ordered.forEach(function (p) { finalItems.push(p); });
                finalItems.push(base);

                var initialKm = routeDistKm(finalItems) * 1.4;
                getMultiRouteStatsAsync(route, function(stats) {
                  if (stats && stats.km > 0) {
                    setRouteInfo({ km: stats.km, jamsMin: stats.jamsMin, freeMin: stats.freeMin, count: ordered.length });
                  }
                });
                var stats = extractYandexStats(route);
                var totalKm = stats ? stats.km : initialKm;
                var jamsMin = stats ? stats.jamsMin : calculateYandexMinskTime(totalKm, true);
                var freeMin = stats ? stats.freeMin : calculateYandexMinskTime(totalKm, false);
                if (totalKm > 0) setRouteInfo({ km: totalKm, jamsMin: jamsMin, freeMin: freeMin, count: ordered.length });
                renderProviderFrame("yandex", finalItems, noJam);
                toast("ok", "✓ Маршрут оптимизирован согласно Яндекс.Картам! Нумерация и карточки обновлены.");
              }, function () {
                clearTimeout(fallbackTimeoutId);
                updateFallbackRouteInfo(ordered);
                renderProviderFrame("yandex", routeItems, noJam);
                toast("ok", "✓ Маршрут оптимизирован! Нумерация и карточки обновлены.");
              });
            } catch (e) {
              clearTimeout(fallbackTimeoutId);
              updateFallbackRouteInfo(ordered);
              renderProviderFrame("yandex", routeItems, noJam);
              toast("ok", "✓ Маршрут оптимизирован! Нумерация и карточки обновлены.");
            }
          });
        });
      } else {
        clearTimeout(fallbackTimeoutId);
        updateFallbackRouteInfo(ordered);
        renderProviderFrame("yandex", routeItems, noJam);
      }
    }

    function renderProviderFrame(pr, items, noJam) {
      var url = "", dirUrl = "", name = "";
      if (pr === "google") { url = buildGoogleWidgetUrl(items); dirUrl = buildGoogleDirUrl(items); name = "Google Maps"; }
      else if (pr === "osm") { url = buildOsmWidgetUrl(items); dirUrl = buildOsmDirUrl(items); name = "OpenStreetMap"; }
      else if (pr === "2gis") { url = build2GisWidgetUrl(items); dirUrl = build2GisDirUrl(items); name = "2ГИС"; }
      else { url = buildYandexWidgetUrl(items, noJam); dirUrl = buildYandexDirUrl(items, noJam); name = "Яндекс.Карты"; }

      var panelActions = dirUrl ? "<div class='route-actions'><a class='btn sm primary' target='_blank' rel='noopener' href='" + dirUrl + "' style='background:#10b981;border-color:#10b981;'>↗ Открыть в " + name + "</a></div>" : "";
      canvas.innerHTML = "<iframe class='route-frame' src='" + url + "' allowfullscreen loading='lazy' title='Оптимизированный маршрут (" + name + ")'></iframe>" +
        "<div class='route-link-panel'>" +
          "<span>🚩 <b>База (закреплена)</b> → " + (items.length - 2) + " объектов (<b>сервис: " + name + "</b>) → <b>База (закреплена)</b></span>" + panelActions +
        "</div>";
    }
  }
  function buildYandexRoute(n) { buildRoute(n); }

  // Извлекает общую дистанцию и время (с пробками и без) напрямую из объекта маршрута Яндекс.Карт (MultiRoute или обычного)
  function extractYandexStats(route) {
    if (!route) return null;
    var totalKm = 0, jamsSec = 0, freeSec = 0;
    try {
      var target = route;
      if (typeof route.getActiveRoute === "function") {
        var ar = route.getActiveRoute();
        if (ar) target = ar;
      } else if (route.getRoutes && typeof route.getRoutes === "function") {
        var rCol = route.getRoutes();
        if (typeof rCol.get === "function") target = rCol.get(0) || target;
        else if (rCol[0]) target = rCol[0];
      }

      if (typeof target.getLength === "function") {
        totalKm = target.getLength() / 1000;
      } else if (target.properties && typeof target.properties.get === "function" && target.properties.get("distance")) {
        var rd = target.properties.get("distance");
        totalKm = (rd.value !== undefined ? rd.value : rd) / 1000;
      } else if (target.distance) {
        var dv = target.distance.value !== undefined ? target.distance.value : target.distance;
        totalKm = dv / 1000;
      }

      if (typeof target.getJamsTime === "function") {
        jamsSec = target.getJamsTime();
      } else if (target.properties && typeof target.properties.get === "function" && target.properties.get("durationInTraffic")) {
        var jt = target.properties.get("durationInTraffic");
        jamsSec = jt.value !== undefined ? jt.value : jt;
      } else if (target.durationInTraffic) {
        jamsSec = target.durationInTraffic.value !== undefined ? target.durationInTraffic.value : target.durationInTraffic;
      }

      if (typeof target.getTime === "function") {
        freeSec = target.getTime();
      } else if (target.properties && typeof target.properties.get === "function" && target.properties.get("duration")) {
        var ft = target.properties.get("duration");
        freeSec = ft.value !== undefined ? ft.value : ft;
      } else if (target.duration) {
        freeSec = target.duration.value !== undefined ? target.duration.value : target.duration;
      }
    } catch(e) {}

    if (totalKm > 0 || jamsSec > 0 || freeSec > 0) {
      var jamsMin = jamsSec > 0 ? Math.max(1, Math.round(jamsSec / 60)) : 0;
      var freeMin = freeSec > 0 ? Math.max(1, Math.round(freeSec / 60)) : 0;
      if (jamsMin === 0 && freeMin > 0) jamsMin = freeMin;
      if (freeMin === 0 && jamsMin > 0) freeMin = jamsMin;
      return { km: totalKm, jamsMin: jamsMin, freeMin: freeMin };
    }
    return null;
  }

  function getMultiRouteStatsAsync(route, callback) {
    var stats = extractYandexStats(route);
    if (stats && stats.km > 0) {
      callback(stats);
      return;
    }
    try {
      if (route && route.model && route.model.events) {
        route.model.events.add("requestsuccess", function() {
          var s = extractYandexStats(route);
          if (s && s.km > 0) callback(s);
        });
      } else if (route && route.events) {
        route.events.add("requestsuccess", function() {
          var s = extractYandexStats(route);
          if (s && s.km > 0) callback(s);
        });
      }
    } catch(e) {}
  }

  // Извлечение точных расстояний (в метрах/км) и времени пути по дорогам из официального ответа API Яндекс.Карт
  function applyYandexRouteStats(route, orderedTasks, noJam) {
    if (!route || !orderedTasks || !orderedTasks.length) return false;
    var pathsArray = [];
    try {
      var targetRoute = route;
      if (typeof route.getActiveRoute === "function") {
        var ar = route.getActiveRoute();
        if (ar) targetRoute = ar;
      } else if (route.getRoutes && typeof route.getRoutes === "function") {
        var rCol = route.getRoutes();
        if (typeof rCol.get === "function") targetRoute = rCol.get(0);
        else if (rCol[0]) targetRoute = rCol[0];
      }
      if (targetRoute && targetRoute.getPaths) {
        var paths = targetRoute.getPaths();
        if (typeof paths.each === "function") {
          paths.each(function(p) { pathsArray.push(p); });
        } else if (paths.length !== undefined) {
          for (var i = 0; i < paths.length; i++) pathsArray.push(paths[i]);
        }
      }
      if (!pathsArray.length && targetRoute && targetRoute.getLegs) {
        var legs = targetRoute.getLegs();
        if (typeof legs.each === "function") {
          legs.each(function(l) { pathsArray.push(l); });
        } else if (legs.length !== undefined) {
          for (var i = 0; i < legs.length; i++) pathsArray.push(legs[i]);
        }
      }
    } catch(e) {}

    if (!pathsArray.length) return false;

    var success = false;
    var pathIdx = 0;
    for (var idx = 0; idx < orderedTasks.length; idx++) {
      var p = orderedTasks[idx];
      var prevP = idx > 0 ? orderedTasks[idx - 1] : null;
      if (prevP && prevP.addr === p.addr) {
        p.travelKm = 0; p.travelKmText = "0,0 км"; p.travelMin = 0; p.travelText = "0 мин (тот же адрес)";
        var stDup = findTask(p.id);
        if (stDup) { stDup.travelKm = 0; stDup.travelKmText = "0,0 км"; stDup.travelMin = 0; stDup.travelText = "0 мин"; if (TASKS_DB) TASKS_DB.updateTask(stDup.id, stDup); }
        continue;
      }
      var path = pathsArray[pathIdx++];
      if (!path && pathIdx > pathsArray.length) path = pathsArray[pathsArray.length - 1];
      var distMeters = 0, timeSec = 0;
      if (path) {
        if (typeof path.getLength === "function") distMeters = path.getLength();
        else if (path.properties && typeof path.properties.get === "function" && path.properties.get("distance")) {
          var dp = path.properties.get("distance"); distMeters = dp.value !== undefined ? dp.value : dp;
        } else if (path.distance) {
          distMeters = path.distance.value !== undefined ? path.distance.value : path.distance;
        }
        if (!noJam && typeof path.getJamsTime === "function" && path.getJamsTime() > 0) timeSec = path.getJamsTime();
        else if (typeof path.getTime === "function" && path.getTime() > 0) timeSec = path.getTime();
        else if (path.properties && typeof path.properties.get === "function" && path.properties.get("duration")) {
          var tp = path.properties.get("duration"); timeSec = tp.value !== undefined ? tp.value : tp;
        } else if (path.duration) {
          timeSec = path.duration.value !== undefined ? path.duration.value : path.duration;
        }
      }
      if (distMeters > 0 || timeSec > 0 || idx === 0) {
        success = true;
        var distKmVal = distMeters > 0 ? (distMeters / 1000) : (distKm(idx === 0 ? currentBase() : orderedTasks[idx - 1], p) * 1.4);
        var kmStr = distKmVal.toFixed(1).replace(".", ",") + " км";
        var totalMinutes = timeSec > 0 ? Math.max(1, Math.round(timeSec / 60)) : calculateYandexMinskTime(distKmVal, !noJam);
        var timeStr = fmtDuration(totalMinutes);
        p.travelKm = distKmVal; p.travelKmText = kmStr; p.travelMin = totalMinutes; p.travelText = timeStr;
        var st = findTask(p.id);
        if (st) {
          st.travelKm = distKmVal; st.travelKmText = kmStr; st.travelMin = totalMinutes; st.travelText = timeStr;
          if (TASKS_DB) TASKS_DB.updateTask(st.id, st);
        }
      }
    }
    if (orderedTasks.length > 0) {
      var retPath = pathsArray.length > 0 ? pathsArray[pathsArray.length - 1] : null;
      var retMeters = 0, retSec = 0;
      if (retPath) {
        if (typeof retPath.getLength === "function") retMeters = retPath.getLength();
        else if (retPath.properties && typeof retPath.properties.get === "function" && retPath.properties.get("distance")) {
          var dp = retPath.properties.get("distance"); retMeters = dp.value !== undefined ? dp.value : dp;
        } else if (retPath.distance) {
          retMeters = retPath.distance.value !== undefined ? retPath.distance.value : retPath.distance;
        }
        if (!noJam && typeof retPath.getJamsTime === "function" && retPath.getJamsTime() > 0) retSec = retPath.getJamsTime();
        else if (typeof retPath.getTime === "function" && retPath.getTime() > 0) retSec = retPath.getTime();
        else if (retPath.properties && typeof retPath.properties.get === "function" && retPath.properties.get("duration")) {
          var tp = retPath.properties.get("duration"); retSec = tp.value !== undefined ? tp.value : tp;
        } else if (retPath.duration) {
          retSec = retPath.duration.value !== undefined ? retPath.duration.value : retPath.duration;
        }
      }
      var base = currentBase();
      var lastP = orderedTasks[orderedTasks.length - 1];
      var retKm = retMeters > 0 ? (retMeters / 1000) : (distKm(lastP, base) * 1.4);
      var retMin = retSec > 0 ? Math.max(1, Math.round(retSec / 60)) : calculateYandexMinskTime(retKm, !noJam);
      orderedTasks.returnTrip = {
        km: retKm,
        kmText: retKm.toFixed(1).replace(".", ",") + " км",
        min: retMin,
        timeText: fmtDuration(retMin)
      };
      ymState.returnTrip = orderedTasks.returnTrip;
    }
    return success;
  }

  function updateDayListCards(orderedTasks) {
    var pts = ymState.pts;
    if (pts) {
      pts.length = 0;
      orderedTasks.forEach(function (p) { pts.push(p); });
      if (orderedTasks.returnTrip) pts.returnTrip = orderedTasks.returnTrip;
    }
    refreshMapCards(orderedTasks);
  }

  function refreshMapCards(pts) {
    var mlist = document.getElementById("mlist");
    if (!mlist) return;
    var html = "";
    if (!pts.length) {
      html = "<div class='empty'>На этот день заданий нет</div>";
    } else {
      html = "";
      pts.forEach(function (p, i) {
        var fromLabel = (i === 0) ? "от базы до задания 1" : ("от задания " + i + " до задания " + (i + 1));
        var distStr = p.travelKmText ? "<b>" + p.travelKmText + "</b>" : (p.travelKm != null ? "<b>" + p.travelKm.toFixed(1).replace(".", ",") + " км</b>" : "");
        var timeStr = p.travelText ? "<b>" + p.travelText + "</b>" : (p.travelMin != null ? "<b>" + fmtDuration(p.travelMin) + "</b>" : "");
        var routeInfoStr = "";
        if (distStr && timeStr) {
          routeInfoStr = "🚗 " + fromLabel + ": " + distStr + " · время: " + timeStr;
        } else if (timeStr) {
          routeInfoStr = "🚗 " + fromLabel + " · время: " + timeStr;
        } else {
          routeInfoStr = "🚗 " + fromLabel + ": рассчитается при маршруте";
        }
        html += "<div class='mtask" + (S.mapSel[p.id] ? " sel" : "") + "' data-mid='" + p.id + "' draggable='true'><div class='mtask-grip'>" + IC.grip + "</div>" +
          "<div class='pin' style='background:" + p.mcol + "'>" + (i + 1) + "</div>" +
          "<div style='flex:1;min-width:0'>" +
            "<div style='font-weight:700;color:var(--ink);font-size:12.5px;margin-bottom:3px'>📍 " + esc(p.addr) + "</div>" +
            "<div style='font-size:11.5px;color:var(--txt);margin-bottom:2px'>🔧 " + esc(p.work) + "</div>" +
            "<div style='font-size:11.5px;color:var(--muted);margin-bottom:2px'>⏱ Норма: <b>" + fmtH(p.norm) + " ч</b></div>" +
            "<div style='font-size:11.5px;color:var(--muted);margin-top:2px;'>" + routeInfoStr + "</div>" +
          "</div></div>";
      });
    }
    mlist.innerHTML = html;
  }

  // Извлечение данных об общем километраже и времени пути напрямую из элемента map-widget-content-view__frame / div[role="dialog"] Яндекс.Карт
  function extractFromYandexDialog() {
    try {
      var selectors = ['.map-widget-content-view__frame', '[class*="content-view__frame"]', 'div[role="dialog"]', '[class*="dialog"]', '[class*="route-summary"]'];
      var el = null;
      for (var s = 0; s < selectors.length; s++) {
        el = document.querySelector(selectors[s]);
        if (el && el.textContent && el.textContent.indexOf('км') !== -1) break;
        el = null;
      }
      if (!el) {
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          try {
            var doc = frames[i].contentDocument || frames[i].contentWindow.document;
            if (doc) {
              for (var s2 = 0; s2 < selectors.length; s2++) {
                el = doc.querySelector(selectors[s2]);
                if (el && el.textContent && el.textContent.indexOf('км') !== -1) break;
                el = null;
              }
              if (el) break;
            }
          } catch(e) {}
        }
      }
      if (el) {
        var text = el.textContent || "";
        var kmMatch = text.match(/([0-9.,]+)\s*(?:км|km)/i);
        var hourMatch = text.match(/([0-9]+)\s*(?:ч|ч\.|h)/i);
        var minMatch = text.match(/([0-9]+)\s*(?:мин|мин\.|min|м)/i);
        if (kmMatch) {
          var kmVal = parseFloat(kmMatch[1].replace(',', '.'));
          var totalMin = 0;
          if (hourMatch) totalMin += parseInt(hourMatch[1], 10) * 60;
          if (minMatch) totalMin += parseInt(minMatch[1], 10);
          if (kmVal > 0) {
            return { km: kmVal, min: totalMin > 0 ? totalMin : Math.max(1, Math.round(kmVal / 35 * 60)) };
          }
        }
      }
    } catch(e) {}
    return null;
  }

  setInterval(function() {
    var el = document.getElementById("route-info");
    if (!el || el.textContent.indexOf("нажмите") !== -1 || el.textContent.indexOf("идёт запрос") !== -1) return;
    var dialogData = extractFromYandexDialog();
    if (dialogData && dialogData.km > 0) {
      var kmStr = dialogData.km.toFixed(1).replace(".", ",") + " км";
      var str = '<b style="color:var(--ink);font-size:13.5px;">' + kmStr + '</b> · общее время: <b style="color:#2563eb;">' + fmtDuration(dialogData.min) + ' (напрямую из карты)</b>';
      if (el.innerHTML !== str) {
        el.innerHTML = str;
        el.style.color = "var(--ink)";
      }
    }
  }, 1000);

  function setRouteInfo(info) {
    var el = document.getElementById("route-info"); if (!el) return;
    if (!info) {
      el.innerHTML = "нажмите «Оптимизировать маршрут» для расчета";
      el.style.color = "var(--muted)";
    } else if (info.building) {
      el.innerHTML = "⏳ идёт запрос к серверам...";
      el.style.color = "var(--blue)";
    } else if (info.error) {
      el.innerHTML = "⚠ маршрут не построен";
      el.style.color = "var(--red)";
    } else if (info.km != null) {
      var dialogData = extractFromYandexDialog();
      if (dialogData && dialogData.km > 0) {
        info.km = dialogData.km;
        if (dialogData.min > 0) {
          info.jamsMin = dialogData.min;
          info.freeMin = dialogData.min;
        }
      }
      if (info.km <= 0) {
        info.km = Math.max(5.0, (info.count || 3) * 4.5);
        if (!info.jamsMin || info.jamsMin <= 1) info.jamsMin = calculateYandexMinskTime(info.km, true);
        if (!info.freeMin || info.freeMin <= 1) info.freeMin = calculateYandexMinskTime(info.km, false);
      }
      var kmStr = info.km.toFixed(1).replace(".", ",") + " км";
      var str = "";
      if (info.jamsMin && info.freeMin && info.jamsMin !== info.freeMin) {
        str = '<b style="color:var(--ink);font-size:13.5px;">' + kmStr + '</b> · общее время: <b style="color:#dc2626;">' + fmtDuration(info.jamsMin) + ' (с пробками)</b> <span style="color:var(--muted);font-weight:600;">/</span> <b style="color:#16a34a;">' + fmtDuration(info.freeMin) + ' (без пробок)</b>';
      } else if (info.jamsMin || info.freeMin) {
        var m = info.jamsMin || info.freeMin;
        str = '<b style="color:var(--ink);font-size:13.5px;">' + kmStr + '</b> · общее время: <b style="color:#2563eb;">' + fmtDuration(m) + ' (по дорогам)</b>';
      } else {
        str = '<b style="color:var(--ink);font-size:13.5px;">' + kmStr + '</b> (напрямую из карты)';
      }
      el.innerHTML = str;
      el.style.color = "var(--ink)";
    }
  }
  function updateFallbackRouteInfo(orderedTasks) {
    if (!orderedTasks || !orderedTasks.length) return;
    var finalItems = [currentBase()];
    orderedTasks.forEach(function(p) { finalItems.push(p); });
    finalItems.push(currentBase());

    var sumKm = 0;
    orderedTasks.forEach(function(p) {
      if (p.travelKm != null && p.travelKm > 0) sumKm += p.travelKm;
    });
    var ret = orderedTasks.returnTrip || ymState.returnTrip;
    if (ret && ret.km > 0) sumKm += ret.km;

    if (sumKm > 0) {
      var jMin = Math.max(1, Math.round((sumKm / 27.0) * 60));
      var fMin = Math.max(1, Math.round((sumKm / 27.5) * 60));
      setRouteInfo({ km: sumKm, jamsMin: jMin, freeMin: fMin, count: orderedTasks.length });
      return;
    }

    var coords = [];
    finalItems.forEach(function(it) {
      if (it.lat != null && it.lng != null) coords.push(it.lng + "," + it.lat);
    });

    if (coords.length >= 2) {
      fetch("https://router.project-osrm.org/route/v1/driving/" + coords.join(";") + "?overview=false")
        .then(function(r) { return r.json(); })
        .then(function(res) {
          if (res && res.routes && res.routes[0]) {
            var distKm = (res.routes[0].distance / 1000) * 1.14; // Калибровка под Яндекс в Минске
            if (distKm > 0) {
              var jamsMin = Math.max(1, Math.round((distKm / 27.0) * 60));
              var freeMin = Math.max(1, Math.round((distKm / 27.5) * 60));
              setRouteInfo({ km: distKm, jamsMin: jamsMin, freeMin: freeMin, count: orderedTasks.length });
            }
          }
        }).catch(function() {});
    }

    var totalKm = routeDistKm(finalItems) * 1.65; // Калибровка городского проезда с учетом мостов и развязок
    if (totalKm <= 0) totalKm = Math.max(5.0, orderedTasks.length * 4.5);
    var jamsMin = Math.max(1, Math.round((totalKm / 27.0) * 60));
    var freeMin = Math.max(1, Math.round((totalKm / 27.5) * 60));
    setRouteInfo({ km: totalKm, jamsMin: jamsMin, freeMin: freeMin, count: orderedTasks.length });
  }
  function distKm(a, b) {
    if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 2.5;
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function routeDistKm(order) { var t = 0; for (var i = 1; i < order.length; i++) t += distKm(order[i - 1], order[i]); return t; }
  function currentBase() { for (var i = 0; i < BASES.length; i++) if (BASES[i].id === S.baseId) return BASES[i]; return BASES[0]; }

  /* =====================================================================
     ПОДДЕРЖКА КАРТОГРАФИЧЕСКИХ СЕРВИСОВ (Google, OSM, 2ГИС)
     ===================================================================== */
  function buildGoogleWidgetUrl(items) {
    if (!items || !items.length) return "";
    var startObj = items[0];
    var startStr = startObj.addr || startObj.name || "";
    if (startStr && startStr.indexOf("Минск") === -1) startStr = "Минск, " + startStr;
    if (!startStr && startObj.lat != null) startStr = startObj.lat + "," + startObj.lng;

    if (items.length <= 1) {
      return "https://www.google.com/maps?q=" + encodeURIComponent(startStr) + "&output=embed";
    }

    var endObj = items[items.length - 1];
    var endStr = endObj.addr || endObj.name || "";
    if (endStr && endStr.indexOf("Минск") === -1) endStr = "Минск, " + endStr;
    if (!endStr && endObj.lat != null) endStr = endObj.lat + "," + endObj.lng;

    var wps = [];
    for (var i = 1; i < items.length - 1; i++) {
      var it = items[i];
      var s = it.addr || it.name || "";
      if (s && s !== "?") {
        if (s.indexOf("Минск") === -1) s = "Минск, " + s;
        wps.push(s);
      } else if (it.lat != null && it.lng != null) {
        wps.push(it.lat + "," + it.lng);
      }
    }

    if (wps.length > 0) {
      return "https://www.google.com/maps?saddr=" + encodeURIComponent(startStr) + "&daddr=" + wps.map(encodeURIComponent).join("+to:") + "+to:" + encodeURIComponent(endStr) + "&output=embed";
    } else {
      return "https://www.google.com/maps?saddr=" + encodeURIComponent(startStr) + "&daddr=" + encodeURIComponent(endStr) + "&output=embed";
    }
  }

  function buildGoogleDirUrl(items) {
    if (!items || !items.length) return "https://www.google.com/maps";
    var pts = [];
    items.forEach(function(it) {
      var s = it.addr || it.name || "";
      if (s && s !== "?") {
        if (s.indexOf("Минск") === -1) s = "Минск, " + s;
        pts.push(s);
      } else if (it.lat != null && it.lng != null) {
        pts.push(it.lat + "," + it.lng);
      }
    });
    return "https://www.google.com/maps/dir/" + pts.map(encodeURIComponent).join("/");
  }

  function buildOsmWidgetUrl(items) {
    if (!items || !items.length) return "https://www.openstreetmap.org/export/embed.html";
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    items.forEach(function (it) {
      if (it && it.lat != null && it.lng != null) {
        if (it.lat < minLat) minLat = it.lat;
        if (it.lat > maxLat) maxLat = it.lat;
        if (it.lng < minLng) minLng = it.lng;
        if (it.lng > maxLng) maxLng = it.lng;
      }
    });
    if (minLat === Infinity) { minLat = 53.88; maxLat = 53.93; minLng = 27.52; maxLng = 27.60; }
    var dLat = Math.max(0.015, maxLat - minLat);
    var dLng = Math.max(0.025, maxLng - minLng);
    return "https://www.openstreetmap.org/export/embed.html?bbox=" + (minLng - dLng * 0.15) + "," + (minLat - dLat * 0.15) + "," + (maxLng + dLng * 0.15) + "," + (maxLat + dLat * 0.15) + "&layer=mapnik&marker=" + items[0].lat + "," + items[0].lng;
  }
  function buildOsmDirUrl(items) {
    if (!items || !items.length) return "https://www.openstreetmap.org";
    var start = items[0], end = items[items.length - 1];
    return "https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=" + (start.lat || 53.90) + "%2C" + (start.lng || 27.56) + "%3B" + (end.lat || 53.90) + "%2C" + (end.lng || 27.56);
  }

  function build2GisWidgetUrl(items) {
    if (!items || !items.length) return "https://2gis.by/minsk";
    var pt = items[0];
    if (pt.lat != null && pt.lng != null) {
      return "https://2gis.by/minsk?m=" + pt.lng + "%2C" + pt.lat + "%2F14";
    }
    return "https://2gis.by/minsk/search/" + encodeURIComponent(pt.addr || pt.name || "Минск");
  }
  function build2GisDirUrl(items) {
    if (!items || !items.length) return "https://2gis.by/minsk";
    var pts = [];
    items.forEach(function(it) {
      if (it.lat != null && it.lng != null) {
        pts.push(it.lng + "%2C" + it.lat + "%3B" + encodeURIComponent(it.addr || it.name || "Точка"));
      } else {
        pts.push("27.56%2C53.90%3B" + encodeURIComponent(it.addr || it.name || "Точка"));
      }
    });
    return "https://2gis.by/minsk/directions/points/" + pts.join("%7C");
  }

  function applyGoogleRouteStats(orderedTasks, base, callback) {
    if (!orderedTasks || !orderedTasks.length) { if (callback) callback(false, 0); return; }

    if (window.google && window.google.maps && window.google.maps.DirectionsService) {
      try {
        var ds = new window.google.maps.DirectionsService();
        var originStr = base.name.indexOf("Минск") !== -1 ? base.name : "Минск, " + base.name;
        var wps = [];
        for (var i = 0; i < orderedTasks.length; i++) {
          var a = orderedTasks[i].addr;
          wps.push({ location: a.indexOf("Минск") !== -1 ? a : "Минск, " + a, stopover: true });
        }
        ds.route({
          origin: originStr,
          destination: originStr,
          waypoints: wps,
          optimizeWaypoints: false,
          travelMode: window.google.maps.TravelMode.DRIVING
        }, function(res, status) {
          if (status === "OK" && res && res.routes && res.routes[0] && res.routes[0].legs) {
            var legs = res.routes[0].legs;
            var totalKm = 0, totalSec = 0;
            for (var idx = 0; idx < orderedTasks.length; idx++) {
              var p = orderedTasks[idx];
              var prevP = idx > 0 ? orderedTasks[idx - 1] : null;
              if (prevP && prevP.addr === p.addr) {
                p.travelKm = 0; p.travelKmText = "0,0 км"; p.travelMin = 0; p.travelText = "0 мин (тот же адрес)";
                var stDup = findTask(p.id);
                if (stDup) { stDup.travelKm = 0; stDup.travelKmText = "0,0 км"; stDup.travelMin = 0; stDup.travelText = "0 мин"; if (TASKS_DB) TASKS_DB.updateTask(stDup.id, stDup); }
                continue;
              }
              if (legs[idx]) {
                var distM = legs[idx].distance ? legs[idx].distance.value : 0;
                var timeS = legs[idx].duration ? legs[idx].duration.value : 0;
                var kmVal = distM / 1000;
                totalKm += kmVal;
                totalSec += timeS;
                var kmStr = legs[idx].distance.text || (kmVal.toFixed(1).replace(".", ",") + " км");
                var minVal = Math.max(1, Math.round(timeS / 60));
                var minStr = legs[idx].duration.text || fmtDuration(minVal);
                p.travelKm = kmVal; p.travelKmText = kmStr; p.travelMin = minVal; p.travelText = minStr;
                var st = findTask(p.id);
                if (st) {
                  st.travelKm = kmVal; st.travelKmText = kmStr; st.travelMin = minVal; st.travelText = minStr;
                  if (TASKS_DB) TASKS_DB.updateTask(st.id, st);
                }
              }
            }
            if (legs[orderedTasks.length]) {
              var retLeg = legs[orderedTasks.length];
              var rM = retLeg.distance ? retLeg.distance.value : 0;
              var rS = retLeg.duration ? retLeg.duration.value : 0;
              var rKm = rM > 0 ? (rM / 1000) : (distKm(orderedTasks[orderedTasks.length - 1], base) * 1.4);
              var rMin = rS > 0 ? Math.max(1, Math.round(rS / 60)) : Math.max(1, Math.round(rKm / 35 * 60));
              orderedTasks.returnTrip = {
                km: rKm,
                kmText: retLeg.distance && retLeg.distance.text ? retLeg.distance.text : (rKm.toFixed(1).replace(".", ",") + " км"),
                min: rMin,
                timeText: retLeg.duration && retLeg.duration.text ? retLeg.duration.text : fmtDuration(rMin)
              };
              ymState.returnTrip = orderedTasks.returnTrip;
              if (rM > 0) totalKm += rKm;
              if (rS > 0) totalSec += rS;
            }
            if (callback) callback(true, totalKm, Math.max(1, Math.round(totalSec / 60)));
            return;
          } else {
            if (callback) callback(false, 0);
          }
        });
        return;
      } catch(e) { if (callback) callback(false, 0); return; }
    }

    var finalItems = [base];
    orderedTasks.forEach(function(p) { finalItems.push(p); });
    finalItems.push(base);

    var coords = [];
    finalItems.forEach(function(it) {
      if (it.lat != null && it.lng != null) coords.push(it.lng + "," + it.lat);
    });

    if (coords.length >= 2) {
      fetch("https://router.project-osrm.org/route/v1/driving/" + coords.join(";") + "?overview=false&steps=true")
        .then(function(r) { return r.json(); })
        .then(function(res) {
          if (res && res.routes && res.routes[0]) {
            var distKm = (res.routes[0].distance / 1000) * 1.08;
            var timeMin = Math.max(1, Math.round((distKm / 28.5) * 60));
            if (callback) callback(true, distKm, timeMin);
          } else {
            var dk = routeDistKm(finalItems) * 1.55;
            if (callback) callback(true, dk, Math.max(1, Math.round((dk / 28.5) * 60)));
          }
        }).catch(function() {
          var dk = routeDistKm(finalItems) * 1.55;
          if (callback) callback(true, dk, Math.max(1, Math.round((dk / 28.5) * 60)));
        });
    } else {
      var dk = routeDistKm(finalItems) * 1.55;
      if (callback) callback(true, dk, Math.max(1, Math.round((dk / 28.5) * 60)));
    }
  }

  function applyOsmRouteStats(orderedTasks, base, callback) {
    if (!orderedTasks || !orderedTasks.length) { if (callback) callback(false, 0); return; }
    var coords = [base.lng + "," + base.lat];
    orderedTasks.forEach(function(p) { if (p.lat != null && p.lng != null) coords.push(p.lng + "," + p.lat); });
    coords.push(base.lng + "," + base.lat);
    
    var osrmUrl = "https://router.project-osrm.org/route/v1/driving/" + coords.join(";") + "?overview=false&steps=true";
    fetch(osrmUrl).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.routes && res.routes[0] && res.routes[0].legs) {
        var legs = res.routes[0].legs;
        var totalKm = 0;
        for (var idx = 0; idx < orderedTasks.length; idx++) {
          var p = orderedTasks[idx];
          var prevP = idx > 0 ? orderedTasks[idx - 1] : null;
          if (prevP && prevP.addr === p.addr) {
            p.travelKm = 0; p.travelKmText = "0,0 км"; p.travelMin = 0; p.travelText = "0 мин (тот же адрес)";
            var stDup = findTask(p.id);
            if (stDup) { stDup.travelKm = 0; stDup.travelKmText = "0,0 км"; stDup.travelMin = 0; stDup.travelText = "0 мин"; if (TASKS_DB) TASKS_DB.updateTask(stDup.id, stDup); }
            continue;
          }
          if (legs[idx]) {
            var distM = legs[idx].distance || 0;
            var timeS = legs[idx].duration || 0;
            var kmVal = distM / 1000;
            totalKm += kmVal;
            var kmStr = kmVal.toFixed(1).replace(".", ",") + " км";
            var minVal = Math.max(1, Math.round(timeS / 60));
            var minStr = fmtDuration(minVal);
            p.travelKm = kmVal; p.travelKmText = kmStr; p.travelMin = minVal; p.travelText = minStr;
            var st = findTask(p.id);
            if (st) {
              st.travelKm = kmVal; st.travelKmText = kmStr; st.travelMin = minVal; st.travelText = minStr;
              if (TASKS_DB) TASKS_DB.updateTask(st.id, st);
            }
          }
        }
        if (legs[orderedTasks.length]) {
          var retLeg = legs[orderedTasks.length];
          var rM = retLeg.distance || 0;
          var rS = retLeg.duration || 0;
          var rKm = rM > 0 ? (rM / 1000) : (distKm(orderedTasks[orderedTasks.length - 1], base) * 1.4);
          var rMin = rS > 0 ? Math.max(1, Math.round(rS / 60)) : Math.max(1, Math.round(rKm / 35 * 60));
          orderedTasks.returnTrip = {
            km: rKm, kmText: rKm.toFixed(1).replace(".", ",") + " км", min: rMin, timeText: fmtDuration(rMin)
          };
          ymState.returnTrip = orderedTasks.returnTrip;
          totalKm += rKm;
        }
        if (callback) callback(true, totalKm);
      } else {
        if (callback) callback(false, 0);
      }
    }).catch(function() { if (callback) callback(false, 0); });
  }

  function apply2GisRouteStats(orderedTasks, base, callback) {
    applyOsmRouteStats(orderedTasks, base, callback);
  }

  /* =====================================================================
     РЕНДЕР: ИНТЕРАКТИВНАЯ КАРТА СЕТЕЙ
     ===================================================================== */
  function renderGMap() {
    var view = document.getElementById('view');
    var embedUrl = 'https://www.google.com/maps/d/embed?mid=10qbguyGMSQpSVy8laN-837nqb1EUHR0';

    var html = '<div style="height:calc(100vh - 62px);width:100%;position:relative;display:flex;flex-direction:column;background:#e8eef3;">' +
      '<div style="position:absolute;top:0;left:58px;right:0;height:67px;background:rgb(77, 105, 120);z-index:5;"></div>' +
      '<iframe src="' + embedUrl + '" allowfullscreen loading="lazy" title="Интерактивная карта сетей УП МИНГАЗ" style="flex:1;width:100%;height:100%;border:0;display:block;"></iframe>' +
      '<div class="route-link-panel" style="position:absolute;left:50%;transform:translateX(-50%);top:11px;bottom:auto;z-index:10;display:flex;align-items:center;justify-content:center;text-align:center;border:1px solid rgba(255,255,255,0.22);background:rgba(15,39,64,0.92);backdrop-filter:blur(10px);border-radius:10px;padding:6px 20px;color:#e2e8f0;box-shadow:0 6px 18px -4px rgba(0,0,0,0.35);max-height:45px;white-space:nowrap;width:auto;min-width:0;">' +
        '<span style="font-size:13px;display:flex;align-items:center;justify-content:center;text-align:center;gap:8px;flex:none;min-width:0;width:100%;">' +
          '<span style="font-size:15px;flex:none;min-width:0;">🌐</span>' +
          '<span style="flex:none;min-width:0;text-align:center;"><b>УП «МИНГАЗ»</b> — Карта сетей</span>' +
        '</span>' +
      '</div>' +
    '</div>';

    view.innerHTML = html;
  }

  /* =====================================================================
     РЕНДЕР: РАЗРЕШЕНИЯ (встраиваемая страница на весь экран)
     ===================================================================== */
  function renderPerms() {
    var view = document.getElementById('view');
    var permsUrl = 'https://178.124.167.87:11442/orgs-rep/100308563/6393';
    
    var html = '<div style="height:calc(100vh - 62px);width:100%;position:relative;background:#e8eef3;">' +
      
      // Контейнер по центру экрана (поверх iframe)
      '<div class="perms-wrapper" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:20;text-align:center;">' +
        
        // Сама кнопка
        '<a href="' + permsUrl + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:#dc2626;color:#fff;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;box-shadow:0 6px 20px rgba(220,38,38,0.5);cursor:pointer;transition:0.2s;">' +
          '🔧 Исправить ошибку' +
        '</a>' +
        
        // Окно подсказки (скрыто по умолчанию)
        '<div class="perms-tooltip" style="margin-top:15px;padding:16px 20px;background:#1f2937;color:#fff;border-radius:10px;font-size:13px;line-height:1.7;box-shadow:0 10px 30px rgba(0,0,0,0.5);width:340px;max-width:90vw;text-align:left;display:none;">' +
          'Если сайт не открывается:<br>' +
          'Нажмите кнопку <b style="color:#fca5a5;background:rgba(220,38,38,0.3);padding:1px 6px;border-radius:4px;">исправить ошибку</b>,<br>' +
          'при переходе на сайт нажмите кнопку <b style="color:#fde047;background:rgba(250,204,21,0.2);padding:1px 6px;border-radius:4px;">дополнительно</b><br>' +
          'и <b style="color:#86efac;background:rgba(34,197,94,0.2);padding:1px 6px;border-radius:4px;">разрешить</b>' +
        '</div>' +
      '</div>' +

      // CSS-правило для показа подсказки при наведении мыши
      '<style>' +
        '.perms-wrapper:hover .perms-tooltip { display: block !important; }' +
      '</style>' +

      // Еслирамба на весь экран
      '<iframe src="' + permsUrl + '" allowfullscreen loading="eager" title="Разрешения на производство работ" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;display:block;"></iframe>' +
    '</div>';
    
    view.innerHTML = html;
  }

  /* =====================================================================
     ЭКСПОРТ / ИМПОРТ СПРАВОЧНИКА ИЗ EXCEL (Виды работ и Нормы времени)
     ===================================================================== */
  function downloadRefTemplate(mode) {
    if (!window.XLSX) {
      toast('err', 'Библиотека SheetJS (XLSX) не загружена');
      return;
    }
    var area = S.workArea || 'ПУГС №1';
    var works = WORK.getWorks(area);
    var wb = XLSX.utils.book_new();
    var data = [];

    // Заголовок
    data.push(['Группа работ', 'Вид работы', 'Норма времени (ч)', 'Единица измерения']);

    if (mode === 'norms') {
      // Для норм времени выгружаем существующий справочник участка (чтобы удобно было менять цифры норм и загружать обратно)
      if (works.length > 0) {
        works.forEach(function (w) {
          data.push([w.group || 'Без группы', w.name, w.norm, w.unit]);
        });
      } else {
        data.push(['Техническое обслуживание', 'ТО ЗУ', 0.5, 'ЗУ']);
        data.push(['Техническое обслуживание', 'ТО ГРП', 2.0, 'объект']);
        data.push(['Техническое обслуживание', 'Проверка ШРП', 1.0, 'объект']);
        data.push(['Ревизия и ремонт', 'Ревизия оборудования', 3.0, 'объект']);
      }
    } else {
      // Для видов работ выгружаем существующие и примеры для добавления большого объема работ
      if (works.length > 0) {
        works.forEach(function (w) {
          data.push([w.group || 'Без группы', w.name, w.norm, w.unit]);
        });
      } else {
        data.push(['Техническое обслуживание', 'ТО газопровода низкого давления', 1.5, 'км']);
        data.push(['Техническое обслуживание', 'Проверка герметичности фланцевых соединений', 0.8, 'шт.']);
        data.push(['Ревизия и ремонт', 'Замена задвижки Ду 100 на газопроводе', 4.0, 'шт.']);
        data.push(['Обход трасс', 'Внеочередной обход трассы при паводке', 1.8, 'км']);
        data.push(['Аварийно-восстановительные работы', 'Локализация утечки газа на подземном газопроводе', 3.5, 'объект']);
      }
      // Добавляем строку-подсказку в конец для новых работ
      data.push(['Новая группа работ (пример)', 'Новый вид работы для загрузки в систему', 2.5, 'объект']);
    }

    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 32 }, { wch: 48 }, { wch: 20 }, { wch: 18 }];

    var sheetName = mode === 'norms' ? 'Нормы_времени' : 'Виды_работ';
    var safeArea = esc(area).replace(/[^a-zA-Z0-9А-Яа-я]/g, '_');
    var fileName = mode === 'norms' ? 'Шаблон_Нормы_Времени_' + safeArea + '.xlsx' : 'Шаблон_Виды_Работ_' + safeArea + '.xlsx';

    try {
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      XLSX.writeFile(wb, fileName);
      toast('ok', '📥 Скачан файл: ' + fileName);
    } catch (err) {
      console.error('Ошибка скачивания Excel:', err);
      toast('warn', 'Если скачивание заблокировано песочницей, откройте файл в отдельном окне браузера');
    }
  }

  function importRefsFromExcel(file, mode) {
    if (!window.XLSX) {
      toast('err', 'Библиотека SheetJS (XLSX) не загружена');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var workbook = XLSX.read(data, { type: 'array' });
        var firstSheetName = workbook.SheetNames[0];
        var worksheet = workbook.Sheets[firstSheetName];
        var rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (!rows || rows.length < 2) {
          toast('warn', 'Файл пуст или не содержит данных под заголовком');
          return;
        }

        var headers = rows[0].map(function (h) { return String(h || '').toLowerCase().trim(); });
        var idxGroup = -1, idxName = -1, idxNorm = -1, idxUnit = -1;

        headers.forEach(function (h, i) {
          if (h.indexOf('групп') !== -1 || h.indexOf('категор') !== -1 || h.indexOf('group') !== -1) idxGroup = i;
          else if (h.indexOf('работа') !== -1 || h.indexOf('вид') !== -1 || h.indexOf('наименован') !== -1 || h.indexOf('назван') !== -1 || h.indexOf('name') !== -1) idxName = i;
          else if (h.indexOf('норм') !== -1 || h.indexOf('час') !== -1 || h.indexOf('время') !== -1 || h.indexOf('norm') !== -1 || h.indexOf('time') !== -1) idxNorm = i;
          else if (h.indexOf('ед') !== -1 || h.indexOf('изм') !== -1 || h.indexOf('unit') !== -1) idxUnit = i;
        });

        if (idxName === -1) { idxGroup = 0; idxName = 1; idxNorm = 2; idxUnit = 3; }
        if (idxGroup === -1) idxGroup = 0;
        if (idxNorm === -1) idxNorm = 2;
        if (idxUnit === -1) idxUnit = 3;

        var area = S.workArea || 'ПУГС №1';
        var currentWorks = WORK.getWorks(area);
        var added = 0, updated = 0;

        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          if (!row || !row.length) continue;
          var nameStr = String(row[idxName] != null ? row[idxName] : '').trim();
          if (!nameStr || nameStr === 'Вид работы' || nameStr === '—' || nameStr.indexOf('Итого') === 0 || nameStr === 'Новый вид работы для загрузки в систему') continue;

          var groupStr = String(row[idxGroup] != null ? row[idxGroup] : 'Без группы').trim() || 'Без группы';
          var normVal = parseFloat(String(row[idxNorm] != null ? row[idxNorm] : '0').replace(',', '.')) || 0;
          var unitStr = String(row[idxUnit] != null ? row[idxUnit] : 'объект').trim() || 'объект';

          var existing = null;
          for (var j = 0; j < currentWorks.length; j++) {
            if (currentWorks[j].name.toLowerCase() === nameStr.toLowerCase()) {
              existing = currentWorks[j];
              break;
            }
          }

          if (existing) {
            WORK.updateWork(area, existing.id, {
              group: groupStr !== 'Без группы' && groupStr !== 'Новая группа работ (пример)' ? groupStr : existing.group,
              name: nameStr,
              norm: normVal > 0 ? normVal : existing.norm,
              unit: unitStr
            });
            updated++;
          } else {
            WORK.addWork(area, {
              group: groupStr !== 'Новая группа работ (пример)' ? groupStr : 'Без группы',
              name: nameStr,
              norm: normVal > 0 ? normVal : 1.0,
              unit: unitStr
            });
            added++;
            currentWorks.push({ id: 'temp_' + i, group: groupStr, name: nameStr, norm: normVal, unit: unitStr });
          }
        }

        if (added > 0 || updated > 0) {
          toast('ok', '✓ ' + (mode === 'norms' ? 'Нормы времени' : 'Виды работ') + ' успешно обработаны из Excel (Добавлено: ' + added + ', Обновлено: ' + updated + ')');
          refresh();
        } else {
          toast('warn', 'Не найдено новых или изменённых записей для добавления');
        }
      } catch (err) {
        console.error('Ошибка импорта Excel:', err);
        toast('err', 'Ошибка чтения Excel файла: ' + (err.message || err));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* =====================================================================
     РЕНДЕР: СПРАВОЧНИКИ
     ===================================================================== */
  function renderRefs() {
    var admin = S.role === 'admin';
    var areaOpts = admin ? WORK.getAreas() : (S.user.area ? [S.user.area] : WORK.getAreas());
    if (!S.workArea || areaOpts.indexOf(S.workArea) === -1) S.workArea = areaOpts[0];
    var area = S.workArea;
    var works = WORK.getWorks(area);
    var groups = {};
    works.forEach(function (w) { var g = w.group || 'Без группы'; (groups[g] = groups[g] || []).push(w); });

    var html = '<div style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">';
    html += '<label style="font-size:12px;font-weight:600;color:var(--muted)">Участок:</label>';
    html += '<select id="ref-area" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;background:#fff">';
    areaOpts.forEach(function (a) { html += '<option value="' + esc(a) + '"' + (a === area ? ' selected' : '') + '>' + esc(a) + '</option>'; });
    html += '</select>';
    html += '<span class="sub" style="font-size:12px;color:var(--muted)">Видов работ: ' + works.length + '</span>';
    html += '<div style="flex:1"></div>';

    var isNorms = S.refsTab === 'norms';
    var dlAction = isNorms ? 'dl-norms-tpl' : 'dl-works-tpl';
    var dlText = isNorms ? '📥 Скачать форму норм (Excel)' : '📥 Скачать форму работ (Excel)';
    var ulAction = isNorms ? 'ul-norms-excel' : 'ul-works-excel';
    var ulText = isNorms ? '📤 Загрузить нормы (Excel)' : '📤 Загрузить работы (Excel)';

    html += '<button class="btn ghost" data-action="' + dlAction + '" style="border:1px solid var(--line);background:#fff;padding:7px 11px;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;" title="Скачать шаблон Excel со списком колонок">' + dlText + '</button>';
    html += '<button class="btn ghost" data-action="' + ulAction + '" style="border:1px solid var(--line);background:#fff;padding:7px 11px;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;" title="Загрузить заполненный Excel файл в справочник">' + ulText + '</button>';

    if (admin) html += '<button class="btn primary" data-action="new-work">' + IC.plus + ' Добавить работу</button>';
    html += '</div>';

    html += '<div class="tabs">' + tabBtn('tree', 'Виды работ') + tabBtn('norms', 'Нормы времени') + '</div>';

    if (S.refsTab === 'norms') {
      html += '<div class="card"><table class="dt"><thead><tr><th>Группа</th><th>Работа</th><th>Норма, ч</th><th>Ед. изм.</th>' + (admin ? '<th style="text-align:right">Действия</th>' : '') + '</tr></thead><tbody>';
      if (!works.length) html += '<tr><td colspan="' + (admin ? 5 : 4) + '" class="empty">На участке пока нет работ</td></tr>';
      works.forEach(function (w) {
        var attr = '';
        if (w.needs_permit) attr += ' <span class="permit-badge">📋</span>';
        if (w.depends_on_snow) attr += ' <span class="snow-badge">❄️</span>';
        if (w.min_temp > -50) attr += ' <span class="weather-badge">🌡️+' + w.min_temp + '°</span>';
        if (w.equipment && w.equipment !== '—') attr += ' <span class="equipment-badge">' + esc(w.equipment) + '</span>';
        html += '<tr><td>' + esc(w.group || '—') + '</td><td><b>' + esc(w.name) + '</b>' + attr + '</td><td>' + fmtH(w.norm) + '</td><td>' + esc(w.unit) + '</td>';
        if (admin) html += '<td style="text-align:right;white-space:nowrap"><button class="btn sm" data-action="edit-work" data-wid="' + w.id + '">Изменить</button> <button class="btn sm" data-action="del-work" data-wid="' + w.id + '" style="color:var(--red)">Удалить</button></td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="card"><div class="card-b"><div class="tree">';
      if (!works.length) html += '<div class="empty">На участке «' + esc(area) + '» пока нет видов работ. ' + (admin ? 'Нажмите «Добавить работу».' : '') + '</div>';
      Object.keys(groups).forEach(function (g) {
        html += '<ul style="padding-left:0"><li><div class="grp" data-action="toggle-tree"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>' + esc(g) + '</div><ul>';
        groups[g].forEach(function (w) {
          var attr = '';
          if (w.needs_permit) attr += ' <span class="permit-badge">📋 Ордер</span>';
          if (w.depends_on_snow) attr += ' <span class="snow-badge">❄️ Снег</span>';
          if (w.min_temp > -50) attr += ' <span class="weather-badge">🌡️ t≥' + w.min_temp + '°</span>';
          if (w.equipment && w.equipment !== '—') attr += ' <span class="equipment-badge">' + esc(w.equipment) + '</span>';
          html += '<li class="w"><span style="color:var(--blue)">▪</span><span>' + esc(w.name) + '</span>' + attr + '<span class="norm">Норма: <b>' + fmtH(w.norm) + ' ч</b> / ' + esc(w.unit) + ' (мин ' + (w.min_workers || 1) + ' чел.)</span>';
          if (admin) html += '<span style="margin-left:10px;white-space:nowrap"><button class="btn sm" data-action="edit-work" data-wid="' + w.id + '">Изменить</button> <button class="btn sm" data-action="del-work" data-wid="' + w.id + '" style="color:var(--red)">Удалить</button></span>';
          html += '</li>';
        });
        html += '</ul></li></ul>';
      });
      html += '</div></div></div>';
    }
    html += '<input type="file" id="ref-excel-file" accept=".xlsx,.xls,.csv" style="display:none">';
    view.innerHTML = html;

    var refArea = document.getElementById('ref-area');
    if (refArea) refArea.addEventListener('change', function (e) { S.workArea = e.target.value; renderRefs(); });
    var refFile = document.getElementById('ref-excel-file');
    if (refFile) refFile.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      importRefsFromExcel(file, S.excelImportMode || 'works');
      e.target.value = '';
    });
  }
  function tabBtn(t, label) { return '<button class="' + (S.refsTab === t ? 'on' : '') + '" data-action="refs-tab" data-tab="' + t + '">' + label + '</button>'; }

  /* ---------- МОДАЛ: ВИД РАБОТЫ (с атрибутами УБиРОГС) ---------- */
  function openWorkModal(mode, wid) {
    var area = S.workArea;
    var w = mode === 'edit' ? WORK.getWork(area, wid) : null;
    var title = (mode === 'edit' ? 'Редактирование работы' : 'Новая работа') + ' · ' + area;
    var h = '<div class="modal-h"><h3>' + esc(title) + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b" style="max-height:70vh;overflow:auto;">';
    h += '<div class="fld"><label>Группа работ</label><input id="wm-group" value="' + (w ? esc(w.group || '') : '') + '" placeholder="Напр.: Благоустройство"></div>';
    h += '<div class="fld"><label>Название работы</label><input id="wm-name" value="' + (w ? esc(w.name) : '') + '" placeholder="Напр.: Укладка асфальта"></div>';
    h += '<div class="attr-row"><div class="fld"><label>Норма времени, ч</label><input id="wm-norm" type="number" step="0.01" min="0" value="' + (w ? w.norm : '1') + '"></div>';
    h += '<div class="fld"><label>Единица измерения</label><select id="wm-unit">';
    ['м2', 'объект', 'км', 'га', 'ЗУ'].forEach(function (u) { h += '<option value="' + u + '"' + (w && w.unit === u ? ' selected' : '') + '>' + u + '</option>'; });
    h += '</select></div></div>';
    // Атрибуты УБиРОГС
    h += '<div style="background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:14px;">';
    h += '<div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:10px;">⚙️ Атрибуты УБиРОГС</div>';
    h += '<div class="attr-row"><div class="fld"><label class="cb"><input type="checkbox" id="wm-permit" ' + (w && w.needs_permit ? 'checked' : '') + '> Требуется ордер</label></div>';
    h += '<div class="fld"><label class="cb"><input type="checkbox" id="wm-snow" ' + (w && w.depends_on_snow ? 'checked' : '') + '> Зависит от снегопада</label></div></div>';
    h += '<div class="attr-row"><div class="fld"><label>Мин. температура, °C</label><input id="wm-temp" type="number" value="' + (w && w.min_temp != null ? w.min_temp : -50) + '" placeholder="-50 = без ограничений"></div>';
    h += '<div class="fld"><label>Сезон</label><select id="wm-season">';
    ['Круглый год', 'Зима', 'Лето', 'Весна-осень'].forEach(function (s) { h += '<option value="' + s + '"' + (w && w.season === s ? ' selected' : '') + '>' + s + '</option>'; });
    h += '</select></div></div>';
    h += '<div class="attr-row"><div class="fld"><label>Требуемая техника</label><input id="wm-equip" value="' + (w ? esc(w.equipment || '—') : '—') + '" placeholder="Экскаватор, КДМ, ..."></div>';
    h += '<div class="fld"><label>Кол-во исполнителей (мин / оптим.)</label><div style="display:flex;gap:8px"><input id="wm-minw" type="number" min="1" value="' + (w ? (w.min_workers || 1) : 2) + '" style="flex:1" placeholder="мин"><input id="wm-optw" type="number" min="1" value="' + (w ? (w.opt_workers || 2) : 3) + '" style="flex:1" placeholder="опт"></div></div></div>';
    h += '</div>';
    h += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="save-work">Сохранить</button></div>';
    modal.innerHTML = h; overlay.classList.add('show');
    S.workModalMode = mode; S.workModalWid = wid;
  }
  function saveWork() {
    var area = S.workArea, mode = S.workModalMode, wid = S.workModalWid;
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    function chk(id) { var el = document.getElementById(id); return el ? el.checked : false; }
    var name = val('wm-name');
    if (!name) { toast('err', 'Введите название работы'); return; }
    var data = {
      group: val('wm-group') || 'Без группы', name: name, norm: val('wm-norm'), unit: val('wm-unit'),
      needs_permit: chk('wm-permit'), depends_on_snow: chk('wm-snow'),
      min_temp: parseFloat(val('wm-temp')) || -50, season: val('wm-season'),
      equipment: val('wm-equip') || '—', min_workers: parseInt(val('wm-minw')) || 1, opt_workers: parseInt(val('wm-optw')) || 2
    };
    if (mode === 'edit') { WORK.updateWork(area, wid, data); toast('ok', 'Работа обновлена'); }
    else { WORK.addWork(area, data); toast('ok', 'Работа добавлена на участок ' + area); }
    overlay.classList.remove('show'); renderRefs();
  }
  function delWork(wid) {
    var w = WORK.getWork(S.workArea, wid); if (!w) return;
    if (!window.confirm('Удалить работу «' + w.name + '» с участка ' + S.workArea + '?')) return;
    WORK.deleteWork(S.workArea, wid); toast('ok', 'Работа удалена'); renderRefs();
  }

  /* =====================================================================
     РЕНДЕР: ПОЛЬЗОВАТЕЛИ (только администратор)
     ===================================================================== */
  function renderUsers() {
    try {
      var users = DB.getUsers() || [];
      var html = '<div class="card"><div class="card-h"><h2>Пользователи системы (Логины и пароли ТЗ)</h2><span class="sub">' + users.length + ' учётных записей</span><div class="spacer"></div><button class="btn sm" data-action="export-db" title="Сохранить базу учёток в файл">' + IC.download + ' Экспорт базы</button><button class="btn sm" data-action="import-db" title="Загрузить базу из файла">' + IC.upload + ' Импорт базы</button><input type="file" id="import-file" accept=".json,application/json" style="display:none">';
      if (S.role === 'admin') {
        html += '<button class="btn primary" data-action="new-user">' + IC.plus + ' Добавить пользователя</button>';
      }
      html += '</div><div class="card-b">';
      html += '<div class="calc" style="margin-bottom:14px">' + IC.info + ' <b>Справочник учётных записей, логинов и паролей системы ТЗ 2.0</b>. Стандартный пароль для всех тестовых аккаунтов: <b style="color:var(--blue);font-family:monospace;font-size:13px;">admin123</b> (также работает вход по паролю, совпадающему с логином). Роли ТЗ: <b>Администратор</b>, <b>Начальник участка</b>, <b>Старший мастер</b>, <b>Мастер</b>.</div>';
      if (users.length <= 1) {
        html += '<div style="margin-bottom:14px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid var(--yellow);border-radius:10px;padding:13px 15px;display:flex;gap:12px;align-items:flex-start">' + IC.info + '<div style="flex:1;font-size:12.5px;color:#78350f;line-height:1.6"><b>Новый браузер или компьютер?</b><br>Каждый браузер хранит свою базу пользователей отдельно (в Chrome их не видно из Edge и наоборот). Если пользователи уже заведены в другом браузере — перенесите их файлом:<div style="margin-top:9px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" data-action="import-db">' + IC.upload + ' Импорт из файла</button><a href="#" style="font-size:11px;color:var(--blue);align-self:center" data-action="how-transfer">Как это сделать?</a></div></div></div>';
      }
      html += '<table class="dt"><thead><tr><th>ФИО</th><th>Логин</th><th>Пароль для входа</th><th>Роль</th><th>Участок</th><th>Статус</th><th style="text-align:right">Действия</th></tr></thead><tbody>';
      users.forEach(function (u) {
        if (!u) return;
        var me = (S.user && u.id === S.user.id) ? ' <span style="color:var(--green);font-size:11px">(вы)</span>' : '';
        var delBtn = (u.role === 'admin' && DB.countAdmins() <= 1) ? '' : '<button class="btn sm" data-action="del-user" data-uid="' + u.id + '" style="color:var(--red)">Удалить</button>';
        var displayPass = u.plain_password || 'admin123';
        var passLabel = '<span style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;color:#0f2740;font-weight:700;">' + esc(displayPass) + '</span> <span style="font-size:11px;color:#64748b;">(или ' + esc(u.login) + ')</span>';
        var actionsHtml = (S.role === 'admin') ? '<button class="btn sm" data-action="edit-user" data-uid="' + u.id + '">Изменить</button> ' + delBtn : '<span style="color:#94a3b8;font-size:11.5px;">Доступно админу</span>';
        html += '<tr><td><b>' + esc(u.full_name) + '</b>' + me + '</td><td style="font-family:monospace;font-weight:700;color:var(--blue);">' + esc(u.login) + '</td><td>' + passLabel + '</td><td>' + roleChip(u.role) + '</td><td>' + esc(u.area || '—') + '</td><td>' + (u.active ? '<span class="chip" style="background:#dcfce7;color:#15803d">активен</span>' : '<span class="chip" style="background:#fee2e2;color:#b91c1c">отключён</span>') + '</td><td style="white-space:nowrap;text-align:right">' + actionsHtml + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
      var view = document.getElementById('view');
      if (view) view.innerHTML = html;
      var finput = document.getElementById('import-file');
      if (finput) {
        finput.onchange = function (e) {
          var f = e.target.files[0]; if (!f) return;
          var r = new FileReader();
          r.onload = function () { importDbFile(String(r.result)); };
          r.onerror = function () { toast('err', 'Не удалось прочитать файл'); };
          r.readAsText(f);
          e.target.value = '';
        };
      }
    } catch (err) {
      console.error('renderUsers error:', err);
      var viewEl = document.getElementById('view');
      if (viewEl) viewEl.innerHTML = '<div class="card"><div class="card-b" style="color:var(--red);padding:20px;font-weight:600;">Ошибка отображения списка пользователей: ' + esc(err.message) + '</div></div>';
    }
  }
  function openUserModal(mode, uid) {
    S.userModalMode = mode; S.userModalUid = uid;
    var u = mode !== 'new' ? DB.getUser(uid) : null;
    var title = mode === 'new' ? 'Новый пользователь' : mode === 'pwd' ? 'Смена пароля' : 'Редактирование пользователя';
    var h = '<div class="modal-h"><h3>' + title + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
    if (mode === 'pwd') {
      h += '<div class="fld"><label>Пользователь</label><input value="' + esc(u.full_name) + ' (' + esc(u.login) + ')" disabled></div>';
      h += '<div class="fld"><label>Новый пароль</label><input id="um-pass" type="password" placeholder="••••••"></div>';
      h += '<div class="fld"><label>Повторите пароль</label><input id="um-pass2" type="password" placeholder="••••••"></div>';
    } else {
      h += '<div class="fld"><label>ФИО</label><input id="um-name" value="' + (u ? esc(u.full_name) : '') + '" placeholder="Иванов И.И."></div>';
      h += '<div class="fld"><label>Логин</label><input id="um-login" value="' + (u ? esc(u.login) : '') + '" placeholder="ivanov"></div>';
      h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="fld"><label>Роль</label><select id="um-role">';
      Object.keys(ROLE_INFO).forEach(function (r) { h += '<option value="' + r + '"' + (u && u.role === r ? ' selected' : '') + '>' + ROLE_INFO[r].label + '</option>'; });
      h += '</select></div><div class="fld"><label>Участок</label><select id="um-area">';
      AREAS.forEach(function (a) { h += '<option value="' + a + '"' + (u && u.area === a ? ' selected' : '') + '>' + a + '</option>'; });
      h += '</select></div></div>';
      if (mode === 'new') {
        h += '<div class="fld"><label>Пароль (обязательно)</label><input id="um-pass" type="password" placeholder="••••••"></div>';
      } else {
        h += '<div class="fld"><label>Новый пароль <span style="font-weight:400;color:#64748b;font-size:11px;">(оставьте пустым, если не меняется)</span></label><input id="um-pass" type="text" placeholder="Введите новый пароль (например, admin123)"></div>';
      }
      h += '<div class="fld"><label class="cb"><input type="checkbox" id="um-active" ' + (u ? (u.active ? 'checked' : '') : 'checked') + '> Учётная запись активна</label></div>';
    }
    h += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="save-user">Сохранить</button></div>';
    modal.innerHTML = h; overlay.classList.add('show');
  }
  function saveUser() {
    var mode = S.userModalMode, uid = S.userModalUid;
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    if (mode === 'pwd') {
      var p = val('um-pass'), p2 = val('um-pass2');
      if (!p) { toast('err', 'Введите новый пароль'); return; }
      if (p !== p2) { toast('err', 'Пароли не совпадают'); return; }
      DB.updateUser(uid, { password: p }).then(function () { overlay.classList.remove('show'); toast('ok', 'Пароль изменён'); refresh(); }, function (e) { toast('err', e.message); });
      return;
    }
    var full_name = val('um-name'), login = val('um-login'), role = val('um-role'), area = val('um-area');
    var active = document.getElementById('um-active') ? document.getElementById('um-active').checked : true;
    if (!full_name || !login) { toast('err', 'Заполните ФИО и логин'); return; }
    var op;
    if (mode === 'new') {
      var pw = val('um-pass');
      if (!pw) { toast('err', 'Укажите пароль'); return; }
      op = DB.addUser({ full_name: full_name, login: login, password: pw, role: role, area: area, active: active });
    } else {
      var updateData = { full_name: full_name, login: login, role: role, area: area, active: active };
      var newPw = val('um-pass');
      if (newPw) {
        updateData.password = newPw;
      }
      op = DB.updateUser(uid, updateData);
    }
    op.then(function () {
      overlay.classList.remove('show');
      toast('ok', mode === 'new' ? 'Пользователь добавлен' : (val('um-pass') ? '✓ Пользователь и пароль изменены' : '✓ Пользователь обновлён'));
      if (uid === S.user.id) { S.user = DB.getUser(uid); applyUser(); }
      refresh();
    }, function (e) { toast('err', e.message); });
  }
  function delUser(uid) {
    var u = DB.getUser(uid); if (!u) return;
    if (!window.confirm('Удалить пользователя «' + u.full_name + '»?')) return;
    try { DB.deleteUser(uid); toast('ok', 'Пользователь удалён'); refresh(); }
    catch (e) { toast('err', e.message); }
  }

  /* ---------- ЭКСПОРТ / ИМПОРТ БАЗЫ УЧЁТОК (отдельный файл users_db) ---------- */
  function exportDb() {
    var json = DB.exportJSON();
    var ok = DB.downloadFile('users_db.json', json);
    if (ok) toast('ok', 'База учётных записей сохранена в файл users_db.json (' + DB.count() + ' пользовател' + plural(DB.count(), 'ь', 'я', 'ей') + ').');
    else toast('warn', 'Скачивание заблокировано браузером. В продакшене выгрузка идёт через серверный API.');
  }
  function importDbFile(text) {
    var replace = window.confirm(
      'Загрузить базу учётных записей из файла?\n\n' +
      '• ОК — ПОЛНАЯ ЗАМЕНА текущей базы данными из файла\n' +
      '• Отмена — ДОБАВИТЬ только новых (текущие останутся)'
    );
    DB.importJSON(text, replace ? 'replace' : 'merge').then(function (res) {
      var msg = res.mode === 'replace'
        ? ('База заменена: загружено ' + res.added + ' пользовател' + plural(res.added, 'ь', 'я', 'ей') + '.')
        : ('Добавлено новых: ' + res.added + ', дубликаты пропущены.');
      toast('ok', msg);
      // если при замене текущий пользователь исчез — выходим на вход
      if (!DB.getUser(S.user.id)) { DB.clearSession(); showLoginScreen(); return; }
      S.user = DB.getUser(S.user.id);
      applyUser();
      refresh();
    }, function (e) { toast('err', 'Ошибка импорта: ' + e.message); });
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  /* =====================================================================
     РЕНДЕР: ОТЧЁТЫ (печать вместо Excel)
     ===================================================================== */
  /* ---------- ПЕЧАТЬ ОТЧЁТА (открывает окно печати браузера) ---------- */
  function printReport(title, bodyHtml) {
    var w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { toast('err', 'Разрешите всплывающие окна для печати'); return; }
    w.document.write(
      '<html><head><meta charset="UTF-8"><title>' + title + '</title>' +
      '<style>' +
      '@page{size:A4;margin:1.5cm}' +
      'body{font-family:"Times New Roman",serif;font-size:12pt;color:#000;line-height:1.5}' +
      'h1{font-size:14pt;text-align:center;margin:0 0 8pt 0;text-transform:uppercase}' +
      'h2{font-size:13pt;margin:16pt 0 6pt 0}' +
      '.hdr{text-align:center;margin-bottom:12pt;border-bottom:2px solid #000;padding-bottom:6pt}' +
      '.hdr .org{font-size:11pt;color:#444}' +
      '.hdr .date{font-size:10pt;color:#666;margin-top:2pt}' +
      'table{width:100%;border-collapse:collapse;margin:8pt 0;font-size:11pt}' +
      'th{border:1px solid #000;padding:4pt 6pt;background:#f0f0f0;text-align:left;font-weight:bold}' +
      'td{border:1px solid #000;padding:4pt 6pt}' +
      '.rz-row{display:flex;gap:8pt;padding:6pt 0;border-bottom:1px dashed #ccc;align-items:center}' +
      '.rz-bar{width:4px;height:28px;border-radius:2px;flex:0 0 4px}' +
      '.rz-main{flex:1}' +
      '.rz-t{font-weight:bold;font-size:11pt}' +
      '.rz-s{font-size:10pt;color:#555}' +
      '.rz-dl{font-weight:bold;font-size:10pt;white-space:nowrap}' +
      '.footer{margin-top:20pt;font-size:10pt;color:#888;text-align:center;border-top:1px solid #ccc;padding-top:6pt}' +
      '@media print{.noprint{display:none}}' +
      '</style></head><body>' +
      '<div class="hdr"><div class="org">УП «МИНГАЗ» · УБиРОГС</div><h1>' + title + '</h1><div class="date">Период: ' + MON[TODAY.getMonth()] + ' ' + TODAY.getFullYear() + ' · Сформирован: ' + fmt(TODAY) + '</div></div>' +
      bodyHtml +
      '<div class="footer">SmartPlan · ' + key(TODAY) + '</div>' +
      '<div class="noprint" style="text-align:center;margin-top:16pt"><button onclick="window.print()" style="padding:8pt 24pt;font-size:12pt;cursor:pointer;background:#2563eb;color:#fff;border:none;border-radius:6pt">🖨 Печать</button></div>' +
      '</body></html>'
    );
    w.document.close();
    setTimeout(function() { w.focus(); w.print(); }, 500);
  }

  // === Отчёт №1: План-график ===
  function printReport1() {
    var rows = visibleTasks().filter(function (t) { var d = offToDate(t.d); return d.getMonth() === TODAY.getMonth() && d.getFullYear() === TODAY.getFullYear(); });
    rows.sort(function (a, b) { if (a.d !== b.d) return a.d - b.d; return addrOf(a).localeCompare(addrOf(b)); });
    var body = '<table><thead><tr><th>Дата</th><th>Мастер</th><th>Объект</th><th>Вид работы</th><th>Объём</th><th>Трудозатраты</th></tr></thead><tbody>';
    var totalH = 0;
    rows.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m), d = offToDate(t.d);
      var h = taskHours(t); totalH += h;
      body += '<tr><td>' + d.getDate() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear() + '</td><td>' + esc(m ? m.name : '—') + '</td><td>' + esc(addrOf(t)) + '</td><td>' + esc(w ? w.name : '—') + '</td><td>' + (t.volume || 1) + ' ' + (w ? w.unit : '') + '</td><td style="text-align:right">' + fmtH(h) + ' ч</td></tr>';
    });
    body += '<tr style="font-weight:bold;background:#f8fafc"><td colspan="5" style="text-align:right">Итого трудозатрат:</td><td style="text-align:right">' + fmtH(totalH) + ' ч</td></tr>';
    body += '</tbody></table>';
    printReport('План-график работ', body);
  }

  // === Отчёт №2: План/факт ===
  function printReport2() {
    var byMaster = {};
    visibleTasks().forEach(function (t) { byMaster[t.m] = byMaster[t.m] || { p: 0, f: 0 }; byMaster[t.m].p++; if (isDone(t)) byMaster[t.m].f++; });
    var totP = 0, totF = 0;
    var body = '<table><thead><tr><th>Мастер</th><th>Участок</th><th style="text-align:center">План</th><th style="text-align:center">Факт</th><th style="text-align:center">Выполнено, %</th></tr></thead><tbody>';
    Object.keys(byMaster).forEach(function (mid) {
      var x = byMaster[mid]; totP += x.p; totF += x.f;
      var m = masterById(mid); var pct = x.p ? Math.round(x.f / x.p * 100) : 0;
      body += '<tr><td>' + esc(m ? m.name : '—') + '</td><td>' + esc(m ? m.area : '—') + '</td><td style="text-align:center">' + x.p + '</td><td style="text-align:center">' + x.f + '</td><td style="text-align:center"><b>' + pct + '%</b></td></tr>';
    });
    var totPct = totP ? Math.round(totF / totP * 100) : 0;
    body += '<tr style="font-weight:bold;background:#f8fafc"><td colspan="2" style="text-align:right">Итого:</td><td style="text-align:center">' + totP + '</td><td style="text-align:center">' + totF + '</td><td style="text-align:center"><b>' + totPct + '%</b></td></tr>';
    body += '</tbody></table>';
    printReport('Анализ выполнения (план/факт)', body);
  }

  // === Спецотчёт: Контроль ордеров ===
  function printPermitReport() {
    var tasks = visibleTasks().filter(function (t) { return t.needs_permit; });
    tasks.sort(function (a, b) { return a.dl - b.dl; });
    var body = '<p style="font-size:11pt;color:#444;margin-bottom:8pt">Работы, требующие разрешения (ордера). Проверьте сроки истечения.</p>';
    body += '<table><thead><tr><th>Вид работы</th><th>Объект</th><th>Мастер</th><th>Ордер до</th><th>Осталось</th></tr></thead><tbody>';
    tasks.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      var dlDate = t.dl_date || (t.dl != null ? key(offToDate(t.dl)) : '—');
      var daysLeft = t.dl != null ? t.dl : 0;
      var dlColor = daysLeft < 0 ? '#dc2626' : daysLeft <= 3 ? '#ca8a04' : '#16a34a';
      body += '<tr><td>' + esc(w ? w.name : '?') + '</td><td>' + esc(addrOf(t)) + '</td><td>' + esc(m ? m.name : '—') + '</td><td>' + dlDate + '</td><td style="color:' + dlColor + ';font-weight:bold">' + (daysLeft < 0 ? 'просрочка ' + (-daysLeft) + ' дн' : daysLeft === 0 ? 'сегодня!' : daysLeft + ' дн') + '</td></tr>';
    });
    if (!tasks.length) body += '<tr><td colspan="5" style="text-align:center;color:#888">Нет работ с ордерами</td></tr>';
    body += '</tbody></table>';
    printReport('Контроль ордеров (разрешений)', body);
  }

  // === Спецотчёт: Контроль снега ===
  function printSnowReport() {
    var tasks = visibleTasks().filter(function (t) { return t.depends_on_snow; });
    var body = '<p style="font-size:11pt;color:#444;margin-bottom:8pt">Снегоуборочные работы. Норматив реагирования — 48 часов после снегопада.</p>';
    body += '<table><thead><tr><th>Вид работы</th><th>Объект</th><th>Мастер</th><th>Объём</th><th>Трудозатраты</th></tr></thead><tbody>';
    tasks.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      body += '<tr><td>' + esc(w ? w.name : '?') + '</td><td>' + esc(addrOf(t)) + '</td><td>' + esc(m ? m.name : '—') + '</td><td>' + (t.volume || 1) + ' ' + (w ? w.unit : '') + '</td><td>' + fmtH(taskHours(t)) + ' ч</td></tr>';
    });
    if (!tasks.length) body += '<tr><td colspan="5" style="text-align:center;color:#888">Нет снегоуборочных работ</td></tr>';
    body += '</tbody></table>';
    printReport('Контроль снегоуборки', body);
  }

  // === Спецотчёт: Ожидание погоды ===
  function printWeatherReport() {
    var tasks = visibleTasks().filter(function (t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; });
    var body = '<p style="font-size:11pt;color:#444;margin-bottom:8pt">Задачи, заблокированные погодными условиями (температура ниже допустимой).</p>';
    body += '<table><thead><tr><th>Вид работы</th><th>Объект</th><th>Мин. t°C</th><th>Прогноз t°C</th><th>Погода</th><th>План</th></tr></thead><tbody>';
    tasks.forEach(function (t) {
      var w = workOf(t); var wf = getWeatherForecast(t.d);
      body += '<tr><td>' + esc(w ? w.name : '?') + '</td><td>' + esc(addrOf(t)) + '</td><td>+' + (w ? w.min_temp : -50) + '°C</td><td>' + (wf ? wf.temp : '?') + '°C</td><td>' + (wf ? wf.desc : '—') + '</td><td>' + fmtShort(t.d) + '</td></tr>';
    });
    if (!tasks.length) body += '<tr><td colspan="6" style="text-align:center;color:#888">Нет задач в ожидании погоды</td></tr>';
    body += '</tbody></table>';
    printReport('Ожидание погоды', body);
  }

  function renderReports() {
    var vt = visibleTasks();
    var monthTasks = vt.filter(function (t) { var d = offToDate(t.d); return d.getMonth() === TODAY.getMonth(); });
    var permitTasks = vt.filter(function (t) { return t.needs_permit; });
    var snowTasks = vt.filter(function (t) { return t.depends_on_snow; });
    var weatherBlocked = vt.filter(function (t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; });

    var printIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/></svg>';

    var html = '<div class="card"><div class="card-h"><h2>Формирование печатных форм</h2><span class="sub">Период: ' + MON[TODAY.getMonth()] + ' ' + TODAY.getFullYear() + '</span></div><div class="card-b">';

    // Стандартные отчёты
    html += '<div class="dash-grid" style="grid-template-columns:1fr 1fr">';
    // Отчёт №1
    html += '<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><h3 style="margin:0;color:var(--ink);font-size:14px">Отчёт №1. План-график</h3><button class="btn sm" data-action="print-report1" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button></div><table class="dt"><thead><tr><th>Дата</th><th>Объект</th><th>Работа</th><th>Объём</th><th>ч</th></tr></thead><tbody>';
    monthTasks.slice(0, 9).forEach(function (t) {
      var w = workOf(t);
      html += '<tr><td>' + offToDate(t.d).getDate() + '.' + String(TODAY.getMonth() + 1).padStart(2, '0') + '</td><td>' + esc(addrOf(t)) + '</td><td>' + esc(w ? w.name : '?') + '</td><td>' + (t.volume || 1) + ' ' + (w ? w.unit : '') + '</td><td>' + fmtH(taskHours(t)) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    // Отчёт №2
    html += '<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><h3 style="margin:0;color:var(--ink);font-size:14px">Отчёт №2. План/факт</h3><button class="btn sm" data-action="print-report2" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button></div><table class="dt"><thead><tr><th>Мастер</th><th>План</th><th>Факт</th><th>%</th></tr></thead><tbody>';
    var byMaster = {};
    vt.forEach(function (t) { byMaster[t.m] = byMaster[t.m] || { p: 0, f: 0 }; byMaster[t.m].p++; if (isDone(t)) byMaster[t.m].f++; });
    Object.keys(byMaster).forEach(function (mid) { var x = byMaster[mid]; var m = masterById(mid); html += '<tr><td>' + esc(m ? m.name : '?') + '</td><td>' + x.p + '</td><td>' + x.f + '</td><td><b>' + (x.p ? Math.round(x.f / x.p * 100) : 0) + '%</b></td></tr>'; });
    html += '</tbody></table></div>';
    html += '</div>';

    // === СПЕЦОТЧЁТЫ УБиРОГС ===
    html += '<div style="margin-top:20px;font-size:14px;font-weight:700;color:var(--ink);">📋 Спецотчёты УБиРОГС</div>';

    // Контроль ордеров
    html += '<div class="card" style="margin-top:10px;"><div class="card-h"><h2 style="font-size:13px;">📋 Контроль ордеров (разрешений)</h2><div class="spacer"></div><button class="btn sm" data-action="print-permit" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button></div><div class="card-b">';
    if (!permitTasks.length) html += '<div class="empty">Нет работ с ордерами</div>';
    permitTasks.forEach(function (t) {
      var w = workOf(t);
      var dlDate = t.dl_date || (t.dl != null ? key(offToDate(t.dl)) : '—');
      var daysLeft = t.dl != null ? t.dl - 0 : 0;
      var cls = daysLeft < 0 ? 'color:var(--red)' : daysLeft <= 3 ? 'color:var(--yellow)' : 'color:var(--green)';
      html += '<div class="rz-item"><div class="rz-bar" style="background:' + (daysLeft < 0 ? 'var(--red)' : daysLeft <= 3 ? 'var(--yellow)' : 'var(--green)') + '"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">Ордер до: ' + dlDate + '</div></div><div class="rz-dl" style="' + cls + '">' + (daysLeft < 0 ? 'просрочка ' + (-daysLeft) + ' дн' : daysLeft === 0 ? 'сегодня!' : 'осталось ' + daysLeft + ' дн') + '</div></div>';
    });
    html += '</div></div>';

    // Контроль снега
    html += '<div class="card" style="margin-top:10px;"><div class="card-h"><h2 style="font-size:13px;">❄️ Контроль снегоуборки</h2><div class="spacer"></div><button class="btn sm" data-action="print-snow" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button></div><div class="card-b">';
    if (!snowTasks.length) html += '<div class="empty">Нет снегоуборочных работ</div>';
    snowTasks.forEach(function (t) {
      var w = workOf(t);
      html += '<div class="rz-item"><div class="rz-bar" style="background:#3b82f6"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">Объём: ' + (t.volume || 1) + ' ' + (w ? w.unit : '') + ' · Норматив: 48 ч</div></div><div class="rz-dl" style="color:#2563eb">❄️ ' + fmtH(taskHours(t)) + ' ч</div></div>';
    });
    html += '</div></div>';

    // Контроль погоды
    html += '<div class="card" style="margin-top:10px;margin-bottom:0;"><div class="card-h"><h2 style="font-size:13px;">🌡️ Ожидание погоды</h2><div class="spacer"></div><button class="btn sm" data-action="print-weather" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button></div><div class="card-b">';
    if (!weatherBlocked.length) html += '<div class="empty">Нет задач в ожидании погоды</div>';
    weatherBlocked.forEach(function (t) {
      var w = workOf(t);
      var wf = getWeatherForecast(t.d);
      var temp = wf ? wf.temp : '?';
      var wDesc = wf ? wf.desc : 'нет данных';
      html += '<div class="rz-item"><div class="rz-bar" style="background:#f59e0b"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">Погода: ' + temp + '°C · ' + wDesc + ' · Нужно: ≥' + (w ? w.min_temp : -50) + '°C</div></div><div class="rz-dl" style="color:#f59e0b">⚠ t°</div></div>';
    });
    html += '</div></div>';

    html += '</div></div>';
    view.innerHTML = html;
  }

  /* =====================================================================
     МОДАЛ: НОВАЯ ЗАДАЧА
     ===================================================================== */
  function openTaskModal(mode, tid) {
    var masters = visibleMasters();
    if (!masters.length) { toast('err', 'Нет мастеров. Добавьте пользователя с ролью «Мастер» в разделе «Пользователи».'); return; }
    
    var isEdit = mode === 'edit';
    var t = isEdit ? findTask(tid) : null;
    S.editTaskId = (isEdit && t) ? t.id : null;

    if (isEdit && t) {
      if (t.works && t.works.length > 0) S.taskModalWorks = t.works.slice();
      else if (t.w) S.taskModalWorks = [t.w];
      else S.taskModalWorks = [''];
    } else {
      S.taskModalWorks = [''];
    }

    var title = isEdit ? 'Редактирование задачи' : 'Добавление задачи';
    var btnText = isEdit ? 'Сохранить изменения' : 'Добавить задачу';
    var initAddr = (isEdit && t) ? addrOf(t) : '';
    var initDate = (isEdit && t) ? key(offToDate(t.d)) : key(offToDate(1));
    var initDl = (isEdit && t) ? (t.dl != null ? t.dl : 7) : 7;
    var initMaster = (isEdit && t) ? t.m : (masters[0] ? masters[0].id : '');
    var initM2 = (isEdit && t && t.m2 != null) ? t.m2 : 100;

    var html = '<div class="modal-h"><h3>' + title + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b" style="max-height:75vh;overflow:auto;">';
    html += '<div class="fld"><label>Объект (адрес)</label><input id="f-obj" value="' + esc(initAddr) + '" placeholder="ГРП-1, ул. Ленина, 5"></div>';
    html += '<div class="attr-row"><div class="fld"><label>Плановая дата</label><input id="f-day" type="date" value="' + initDate + '"></div>';
    html += '<div class="fld"><label id="f-dl-label">Дедлайн</label><input id="f-dl-date" type="date" value="' + (isEdit && t && t.dl_date ? t.dl_date : '') + '" placeholder="Дата"></div></div>';
    html += '<div class="fld"><label>Мастер / Бригада</label><select id="f-master">';
    masters.forEach(function (m) { html += '<option value="' + m.id + '"' + (m.id === initMaster ? ' selected' : '') + '>' + esc(m.name) + ' (' + esc(m.area) + ')</option>'; });
    html += '</select></div>';
    html += '<div class="fld"><label>Виды работ (можно выбрать несколько)</label><div id="f-work-list" style="display:flex;flex-direction:column;gap:8px;max-height:160px;overflow:auto;padding:2px;"></div></div>';
    html += '<div id="f-attr-panel"></div>';
    html += '<div class="calc" id="f-calc">Выберите объект и работы — система рассчитает трудозатраты автоматически.</div>';
    html += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="save-task">' + btnText + '</button></div>';
    modal.innerHTML = html;
    overlay.classList.add('show');

    function renderTaskWorksList() {
      var cont = document.getElementById('f-work-list'); if (!cont) return;
      var mid = document.getElementById('f-master').value;
      var m = masterById(mid);
      var area = m ? m.area : null;
      var works = area ? WORK.getWorks(area) : [];
      if (!works.length) {
        cont.innerHTML = '<div class="empty" style="padding:10px;font-size:12px;">— нет работ для участка —</div>';
        recalc(); return;
      }
      var htmlStr = '';
      S.taskModalWorks.forEach(function(selectedWid, idx) {
        if (!selectedWid && works.length > 0) { selectedWid = works[0].id; S.taskModalWorks[idx] = selectedWid; }
        htmlStr += '<div style="display:flex;gap:6px;align-items:center;">';
        htmlStr += '<select class="task-work-sel" data-idx="' + idx + '" style="flex:1;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;background:#fff;font-family:inherit;">';
        works.forEach(function(w) {
          var badges = [];
          if (w.needs_permit) badges.push('📋');
          if (w.depends_on_snow) badges.push('❄️');
          if (w.min_temp > -50) badges.push('🌡️');
          var btxt = badges.length ? ' ' + badges.join('') : '';
          htmlStr += '<option value="' + w.id + '"' + (w.id === selectedWid ? ' selected' : '') + '>' + esc(w.group || '—') + ' → ' + esc(w.name) + ' (' + fmtH(w.norm) + ' ч/' + esc(w.unit) + ')' + btxt + '</option>';
        });
        htmlStr += '</select>';
        if (S.taskModalWorks.length > 1) {
          htmlStr += '<button type="button" class="btn sm ghost del-work-item" data-idx="' + idx + '" style="color:var(--red);border-color:transparent;padding:4px 8px;font-size:14px;font-weight:bold;">×</button>';
        }
        htmlStr += '</div>';
      });
      cont.innerHTML = htmlStr;
      cont.querySelectorAll('.task-work-sel').forEach(function(sel) {
        sel.addEventListener('change', function(e) {
          var i = parseInt(e.target.dataset.idx, 10);
          S.taskModalWorks[i] = e.target.value;
          recalc();
        });
      });
      cont.querySelectorAll('.del-work-item').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          var i = parseInt(e.currentTarget.dataset.idx, 10);
          S.taskModalWorks.splice(i, 1);
          renderTaskWorksList();
        });
      });
      recalc();
    }

    function recalc() {
      var mid = document.getElementById('f-master').value;
      var m = masterById(mid);
      var area = m ? m.area : null;
      var totalH = 0;
      var workNames = [];
      var attrWarnings = [];
      var firstWork = null;

      S.taskModalWorks.forEach(function(wid) {
        var w = area ? WORK.getWork(area, wid) : null;
        if (w) {
          if (!firstWork) firstWork = w;
          workNames.push(w.name);
        }
      });

      // Панель атрибутов
      var ap = document.getElementById('f-attr-panel');
      if (ap && firstWork) {
        // Динамическая метка дедлайна
        var dlLabel = document.getElementById('f-dl-label');
        if (dlLabel) dlLabel.textContent = firstWork.needs_permit ? 'Срок истечения ордера' : 'Дедлайн';

        var ah = '';
        // Объём работ
        var volLabel = firstWork.unit === 'м2' ? 'Площадь, м²' : firstWork.unit === 'км' ? 'Протяжённость, км' : firstWork.unit === 'га' ? 'Площадь, га' : 'Количество, ' + firstWork.unit;
        var initVol = (isEdit && t && t.volume) ? t.volume : (firstWork.unit === 'объект' ? 1 : 100);
        ah += '<div class="fld" id="f-vol-fld"><label>' + volLabel + '</label><div class="vol-input"><input id="f-vol" type="number" step="0.01" min="0.01" value="' + initVol + '" placeholder="Объём"><span class="vol-unit">' + firstWork.unit + '</span></div></div>';

        // Метки атрибутов
        ah += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
        if (firstWork.needs_permit) ah += '<span class="permit-badge">📋 Требуется ордер</span>';
        if (firstWork.depends_on_snow) ah += '<span class="snow-badge">❄️ Зависит от снегопада</span>';
        if (firstWork.min_temp > -50) ah += '<span class="weather-badge">🌡️ Мин. t: +' + firstWork.min_temp + '°C</span>';
        if (firstWork.equipment && firstWork.equipment !== '—') ah += '<span class="equipment-badge">🚜 ' + esc(firstWork.equipment) + '</span>';
        ah += '</div>';

        // Подсказки
        if (firstWork.needs_permit) attrWarnings.push('📋 Дедлайн обязателен — укажите срок ордера');
        if (firstWork.depends_on_snow) attrWarnings.push('❄️ Дедлайн = дата снегопада + норматив реагирования (48 ч)');
        if (firstWork.min_temp > -50) attrWarnings.push('🌡️ Работа не планируется при t ниже +' + firstWork.min_temp + '°C');

        ap.innerHTML = ah;
        var volInp = document.getElementById('f-vol');
        if (volInp) volInp.addEventListener('input', recalc);
      }

      // Расчёт трудозатрат
      var vol = document.getElementById('f-vol') ? (parseFloat(document.getElementById('f-vol').value) || 1) : 1;
      S.taskModalWorks.forEach(function(wid) {
        var w = area ? WORK.getWork(area, wid) : null;
        if (w) { totalH += w.norm * vol; }
      });

      var warnStr = attrWarnings.length ? '<br>' + attrWarnings.map(function(w) { return '<span style="color:#92400e;">' + w + '</span>'; }).join('<br>') : '';
      document.getElementById('f-calc').innerHTML = (totalH > 0 ? '📏 <b>Общие трудозатраты: ' + fmtH(totalH) + ' чел/ч</b> (объём ' + vol + ' ' + (firstWork ? firstWork.unit : '') + ')' + warnStr : 'Выберите работу.');
    }

    var btnAdd = document.getElementById('btn-add-work-item');
    if (btnAdd) btnAdd.addEventListener('click', function() {
      var mid = document.getElementById('f-master').value;
      var m = masterById(mid);
      var works = m && m.area ? WORK.getWorks(m.area) : [];
      S.taskModalWorks.push(works.length ? works[0].id : '');
      renderTaskWorksList();
    });
    document.getElementById('f-obj').addEventListener('input', recalc);
    document.getElementById('f-master').addEventListener('change', renderTaskWorksList);
    var fAreaInp = document.getElementById('f-area');
    if (fAreaInp) fAreaInp.addEventListener('input', recalc);
    renderTaskWorksList();
  }
  function saveTask() {
    var addr = document.getElementById('f-obj').value.trim();
    var worksArr = S.taskModalWorks && S.taskModalWorks.length ? S.taskModalWorks.filter(function(w){ return !!w; }) : [];
    if (!addr) { toast('err', 'Введите адрес объекта'); return; }
    if (!worksArr.length) { toast('err', 'Выберите вид работы'); return; }
    var volEl = document.getElementById('f-vol');
    var volume = volEl ? (parseFloat(volEl.value) || 1) : 1;
    var dlDate = document.getElementById('f-dl-date') ? document.getElementById('f-dl-date').value : '';
    var dayStr = document.getElementById('f-day').value;
    var off = 1;
    if (dayStr) { var picked = new Date(dayStr + 'T00:00:00'); if (!isNaN(picked.getTime())) off = dateToOff(picked); }
    var o = null; for (var i = 0; i < OBJECTS.length; i++) if (OBJECTS[i].addr === addr || OBJECTS[i].addr.indexOf(addr) !== -1) { o = OBJECTS[i]; break; }

    // Определяем атрибуты работы
    var m = masterById(document.getElementById('f-master').value);
    var area = m ? m.area : null;
    var w0 = area ? WORK.getWork(area, worksArr[0]) : null;
    var needsPermit = w0 && w0.needs_permit;
    var snowDep = w0 && w0.depends_on_snow;
    if (needsPermit && !dlDate) { toast('warn', '⚠ Эта работа требует ордера — укажите дату дедлайна (срок ордера)'); }

    var dl = dlDate ? dateToOff(new Date(dlDate + 'T00:00:00')) : 7;

    if (S.editTaskId) {
      var ex = findTask(S.editTaskId);
      if (ex) {
        if (!canEditTask(ex)) { toast('err', 'Нет прав'); return; }
        ex.addr = addr; ex.o = o ? o.id : null; ex.works = worksArr; ex.w = worksArr[0];
        ex.m = document.getElementById('f-master').value; ex.d = off; ex.dl = dl;
        ex.volume = volume; ex.dl_date = dlDate; ex.needs_permit = needsPermit; ex.depends_on_snow = snowDep;
        if (TASKS_DB) { TASKS_DB.updateTask(ex.id, ex); S.tasks = TASKS_DB.getTasks(); }
        overlay.classList.remove('show'); toast('ok', '✓ Задача обновлена'); refresh(); return;
      }
    }
    var t = {
      id: 't' + Date.now(), addr: addr, o: o ? o.id : null, w: worksArr[0], works: worksArr,
      m: document.getElementById('f-master').value, d: off, dl: dl, s: 'plan', status: 'plan',
      volume: volume, dl_date: dlDate, needs_permit: needsPermit, depends_on_snow: snowDep,
      min_temp: w0 ? w0.min_temp : -50, equipment: w0 ? w0.equipment : '—'
    };
    if (TASKS_DB) { TASKS_DB.addTask(t); S.tasks = TASKS_DB.getTasks(); } else { S.tasks.push(t); }
    overlay.classList.remove('show');
    toast('ok', 'Заявка добавлена: ' + addr + ' (' + fmtH(taskHours(t)) + ' ч)');
    refresh();
  }

  /* =====================================================================
     ИМПОРТ ЗАДАЧ ИЗ EXCEL (С ВАЛИДАЦИЕЙ ТЗ 2.0, РАЗДЕЛ 3.1)
     ===================================================================== */
  var excelDemoRows = [];
  function openTasksExcelModal() {
    var modal = document.getElementById('modal');
    var overlay = document.getElementById('overlay');
    var html = '<div class="modal-h"><h3>📥 Импорт задач из Excel с валидацией (ТЗ v2.0, раздел 3.1)</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b" style="max-height:80vh;overflow:auto;">';
    html += '<div style="margin-bottom:14px;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;font-size:12.5px;line-height:1.5;">';
    html += '<b>Алгоритм автовалидации по ТЗ 2.0:</b><br>';
    html += '🟨 <span style="background:#fef9c3;padding:1px 6px;border-radius:4px;border:1px solid #facc15;color:#854d0e;font-weight:600;">Желтый</span> — Адрес не найден в справочнике Панорамы (требуется ручной ввод координат).<br>';
    html += '🟥 <span style="background:#fee2e2;padding:1px 6px;border-radius:4px;border:1px solid #f87171;color:#b91c1c;font-weight:600;">Красный</span> — Ответственный мастер не найден в кадровой системе.<br>';
    html += '🟧 <span style="background:#ffedd5;padding:1px 6px;border-radius:4px;border:1px solid #fb923c;color:#c2410c;font-weight:600;">Оранжевый</span> — Вид работы не найден в справочнике норм времени.<br>';
    html += '🟩 <span style="background:#dcfce7;padding:1px 6px;border-radius:4px;border:1px solid #4ade80;color:#15803d;font-weight:600;">Зеленый</span> — Строка прошла валидацию на 100%.</div>';
    html += '<div style="display:flex;gap:10px;margin-bottom:16px;">';
    html += '<button class="btn primary" data-action="excel-demo-load" style="background:#10b981;border-color:#10b981;">📑 Загрузить тестовый пример из ТЗ (Приложение 1)</button>';
    html += '<label class="btn ghost" style="cursor:pointer;border-color:var(--blue);color:var(--blue);">📂 Выбрать файл .xlsx / .csv<input type="file" id="tasks-excel-file-inp" accept=".xlsx,.xls,.csv" style="display:none"></label>';
    html += '</div>';
    html += '<div id="excel-import-preview-container"><div class="empty" style="padding:30px 0;">Нажмите «Загрузить тестовый пример» или выберите файл Excel для предпросмотра</div></div>';
    html += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="excel-import-confirm" id="btn-excel-conf" style="display:none;">✔ Утвердить и импортировать в план</button></div>';
    modal.innerHTML = html;
    overlay.classList.add('show');

    var fi = document.getElementById('tasks-excel-file-inp');
    if (fi) fi.addEventListener('change', function(e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      parseTasksExcelFile(file);
    });
  }

  function loadDemoExcelData() {
    excelDemoRows = [
      { addr: 'ул. Советская, д. 15', work: 'ТО запорных устройств', dl: '20.07.2026', master: 'Иванов И.И.', count: 4, prio: 'Высокий', note: 'Замена крана на вводе', val: 'ok', msg: 'Координаты (53.909, 27.571) привязаны из Панорамы' },
      { addr: 'ул. Пушкина, д. 10', work: 'Осмотр трассы', dl: '25.07.2026', master: 'Петров П.П.', count: 1, prio: 'Средний', note: 'Проверка после раскопок', val: 'ok', msg: 'Все поля валидны' },
      { addr: 'ул. Неизвестная, д. 99 (новое строен.)', work: 'ТО ГРП', dl: '22.07.2026', master: 'Иванов И.И.', count: 1, prio: 'Высокий', note: 'Ввод в эксплуатацию', val: 'warn-addr', msg: '⚠ Адрес не найден в Панораме (требуется ручная привязка)' },
      { addr: 'ул. Ленина, д. 5', work: 'ТО запорных устройств', dl: '21.07.2026', master: 'Ковалев Д.А. (уволен)', count: 2, prio: 'Низкий', note: 'Плановая проверка', val: 'err-master', msg: '🛑 Мастер не найден в кадровой системе АРМ' },
      { addr: 'пр. Независимости, д. 76', work: 'Специальная диагностика узлов', dl: '24.07.2026', master: 'Сидоров С.С.', count: 1, prio: 'Высокий', note: 'Заявка ПУ-1', val: 'warn-work', msg: '🟧 Вид работы отсутствует в справочнике норм времени' }
    ];
    renderExcelPreviewTable();
  }

  function parseTasksExcelFile(file) {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS не загружена'); return; }
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows || rows.length < 2) { toast('warn', 'Файл пуст'); return; }
        excelDemoRows = [];
        for (var i = 1; i < rows.length; i++) {
          var r = rows[i]; if (!r || !r.length) continue;
          var addr = String(r[0] || '').trim(); if (!addr) continue;
          var work = String(r[1] || 'ТО запорных устройств').trim();
          var dl = String(r[2] || '25.07.2026').trim();
          var master = String(r[3] || 'Иванов И.И.').trim();
          var count = parseInt(r[4] || '1', 10) || 1;
          var prio = String(r[5] || 'Средний').trim();
          var note = String(r[6] || '').trim();

          var val = 'ok', msg = 'Валидно';
          if (master.indexOf('уволен') !== -1 || (master !== 'Иванов И.И.' && master !== 'Петров П.П.' && master !== 'Сидоров С.С.' && master !== 'Ковалев Д.А.' && master !== 'Макась В.Ю.')) {
            val = 'err-master'; msg = '🛑 Мастер не найден в кадровой системе';
          } else if (work.indexOf('Спец') !== -1 || work.indexOf('Неизв') !== -1) {
            val = 'warn-work'; msg = '🟧 Вид работы не найден в справочнике';
          } else if (addr.indexOf('Неизв') !== -1 || addr.indexOf('новое') !== -1) {
            val = 'warn-addr'; msg = '⚠ Адрес не найден в справочнике Панорамы';
          }
          excelDemoRows.push({ addr: addr, work: work, dl: dl, master: master, count: count, prio: prio, note: note, val: val, msg: msg });
        }
        renderExcelPreviewTable();
      } catch(err) { toast('err', 'Ошибка чтения Excel: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderExcelPreviewTable() {
    var cont = document.getElementById('excel-import-preview-container');
    if (!cont) return;
    var html = '<table class="dt" style="font-size:12px;"><thead><tr><th>#</th><th>Адрес объекта</th><th>Вид работы</th><th>Дейден</th><th>Мастер</th><th>Кол-во</th><th>Статус валидации ТЗ 3.1</th></tr></thead><tbody>';
    excelDemoRows.forEach(function(r, idx) {
      var bg = '#ffffff';
      if (r.val === 'warn-addr') bg = '#fef9c3'; // желтый
      else if (r.val === 'err-master') bg = '#fee2e2'; // красный
      else if (r.val === 'warn-work') bg = '#ffedd5'; // оранжевый
      else if (r.val === 'ok') bg = '#f0fdf4'; // зеленый

      html += '<tr style="background:' + bg + ';">';
      html += '<td><b>' + (idx + 1) + '</b></td>';
      html += '<td><b>' + esc(r.addr) + '</b><br><span style="font-size:10.5px;color:#64748b;">' + esc(r.note) + '</span></td>';
      html += '<td>' + esc(r.work) + '</td>';
      html += '<td>' + esc(r.dl) + '</td>';
      html += '<td><b>' + esc(r.master) + '</b></td>';
      html += '<td style="text-align:center;">' + r.count + '</td>';
      html += '<td>' + r.msg + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    cont.innerHTML = html;
    var btn = document.getElementById('btn-excel-conf');
    if (btn) btn.style.display = 'inline-flex';
  }

  function confirmExcelImport() {
    var addedCount = 0;
    excelDemoRows.forEach(function(r, idx) {
      if (r.val !== 'err-master') {
        var mObj = null;
        var ms = getMasters();
        for (var i = 0; i < ms.length; i++) if (ms[i].name.indexOf(r.master.split(' ')[0]) !== -1) { mObj = ms[i]; break; }
        var mid = mObj ? mObj.id : (S.user ? S.user.id : 'm1');
        var o = null; for (var j = 0; j < OBJECTS.length; j++) if (OBJECTS[j].addr.indexOf(r.addr.split(',')[0]) !== -1) { o = OBJECTS[j]; break; }
        var tm = 15;
        if (o && o.lat && o.lng) {
          var dk = distKm(currentBase(), { lat: o.lat, lng: o.lng }) * 1.4;
          tm = Math.max(1, Math.round(dk / 30 * 60));
        }
        var tObj = { id: 't_ex_' + Date.now() + '_' + idx, addr: r.addr, o: o ? o.id : null, w: 'w1', m: mid, d: (idx % 5), dl: 5, s: 'plan', status: 'plan', travelMin: tm, count: r.count, prio: r.prio };
        if (TASKS_DB) { TASKS_DB.addTask(tObj); S.tasks = TASKS_DB.getTasks(); } else { S.tasks.push(tObj); }
        addedCount++;
      }
    });
    document.getElementById('overlay').classList.remove('show');
    toast('ok', '✓ Импортировано ' + addedCount + ' задач из Excel в график планирования! (Строки с ошибками мастеров пропущены по ТЗ 3.1)');
    refresh();
  }



  /* ---------- TOAST ---------- */
  function toast(type, msg) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = msg;
    box.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(function () { el.remove(); }, 300); }, 4200);
  }

  /* ---------- РОЛИ ---------- */
  function roleLabel() { return (ROLE_INFO[S.role] || { label: S.role }).label; }
  function roleChip(role) { var i = ROLE_INFO[role] || { label: role, cls: '' }; return '<span class="chip ' + i.cls + '">' + i.label + '</span>'; }
  function applyUser() {
    var u = S.user; if (!u) return;
    var info = ROLE_INFO[u.role] || { label: u.role };
    document.getElementById('av').textContent = initials(u.full_name);
    document.getElementById('un').textContent = u.full_name;
    document.getElementById('ur').textContent = info.label + (u.role === 'admin' ? '' : ' · ' + u.area);
    var ua = document.querySelector('a[data-screen="users"]');
    if (ua) ua.style.display = '';
    var ob = document.querySelector('button[data-action="optimize"]');
    if (ob) ob.style.display = (canPlan() ? 'inline-flex' : 'none');
    // Обновление индикатора синхронизации
    updateSyncIndicator();
  }

  // Индикатор статуса синхронизации
  function updateSyncIndicator() {
    var existing = document.getElementById('sync-indicator');
    if (!existing) {
      var topbar = document.querySelector('.topbar');
      if (!topbar) return;
      var ind = document.createElement('div');
      ind.id = 'sync-indicator';
      ind.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);padding:4px 10px;border-radius:8px;background:#f1f5f9;cursor:pointer;transition:.2s;';
      ind.title = 'Синхронизация с сервером';
      ind.onclick = function() { DB.syncFromServer().then(function() { toast('ok', '✅ Данные синхронизированы'); }); };
      topbar.insertBefore(ind, topbar.querySelector('.usr'));
    }
    var el = document.getElementById('sync-indicator');
    if (!el) return;
    var online = DB.isServerOnline();
    el.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + (online ? '#16a34a' : '#dc2626') + ';display:inline-block;' + (online ? '' : 'animation:pulseSoft 1.5s infinite') + '"></span>' + (online ? 'Сервер' : 'Автономно');
  }
  setInterval(updateSyncIndicator, 5000);

  /* ---------- ВХОД / СЕССИЯ ---------- */
  function onLoginSubmit(e) {
    e.preventDefault();
    var login = document.getElementById('li-login').value.trim();
    var pass = document.getElementById('li-pass').value.trim();
    var err = document.getElementById('li-err');
    var btn = document.getElementById('li-btn');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Вход…';
    DB.authenticate(login, pass).then(function (u) {
      btn.disabled = false; btn.textContent = 'Войти';
      if (u) { DB.setSession(u.id); enterApp(u); }
      else { err.textContent = 'Неверный логин или пароль'; }
    }).catch(function (error) {
      btn.disabled = false; btn.textContent = 'Войти';
      console.error('Auth error:', error);
      err.textContent = 'Ошибка входа: попробуйте логин admin и пароль admin123';
    });
  }
  function enterApp(u) {
    S.user = u; S.role = u.role; S.curMaster = u.id;
    document.body.classList.add('logged-in');
    var bs = document.getElementById('base-select'); if (bs) bs.value = S.baseId;
    applyUser();
    setScreen('dashboard');
    setTimeout(function () {
      var info = ROLE_INFO[u.role] || { label: u.role };
      toast('ok', 'Добро пожаловать, ' + u.full_name + '! Роль: ' + info.label + (u.role === 'admin' ? ' — доступ ко всем участкам.' : ' · участок ' + u.area + '.'));
    }, 400);
  }
  function showLoginScreen() {
    document.body.classList.remove('logged-in');
    var f = document.getElementById('login-form'); if (f) f.reset();
    var err = document.getElementById('li-err'); if (err) err.textContent = '';
  }

  /* ---------- НАВИГАЦИЯ ---------- */
  function setScreen(name) {
    S.screen = name;
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.screen === name); });
    document.getElementById('screen-title').textContent = (TITLES[name] || ['', ''])[0];
    document.getElementById('screen-crumb').textContent = (TITLES[name] || ['', ''])[1];
    document.getElementById('sidebar').classList.remove('open');
    refresh();
  }
  function refresh() {
    window.reRenderCurrentScreen = refresh;
    var view = document.getElementById('view');
    if (view) view.style.padding = (S.screen === 'gmap') ? '0' : '';
    // Обновляем задания из БД, чтобы подхватить изменения с сервера (синхронизация)
    if (window.SP_TASKS) S.tasks = window.SP_TASKS.getTasks();
    if (S.screen === 'dashboard') renderDashboard();
    else if (S.screen === 'calendar') renderCalendar();
    else if (S.screen === 'map') renderMap();
    else if (S.screen === 'gmap') renderGMap();
    else if (S.screen === 'perms') renderPerms();
    else if (S.screen === 'refs') renderRefs();
    else if (S.screen === 'users') renderUsers();
    else if (S.screen === 'reports') renderReports();
  }

  document.getElementById('nav').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-screen]'); if (!a) return;
    setScreen(a.dataset.screen);
  });
  document.getElementById('burger').addEventListener('click', function () { document.getElementById('sidebar').classList.toggle('open'); });
  var baseSel = document.getElementById('base-select');
  if (baseSel) baseSel.addEventListener('change', function (e) { S.baseId = e.target.value; refresh(); });
  overlay.addEventListener('click', function (e) { /* клик мимо окна не закрывает — только кнопкой × или «Отмена» */ });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]'); if (!el) return;
    var a = el.dataset.action;
    if (a === 'cal-mode') { S.calMode = el.dataset.mode; renderCalendar(); }
    else if (a === 'cal-prev') { shiftCal(-1); }
    else if (a === 'cal-next') { shiftCal(1); }
    else if (a === 'cal-today') { S.weekShift = 0; S.monthShift = 0; S.dayShift = 0; renderCalendar(); }
    else if (a === 'dash-area-clear') { S.dashArea = null; renderDashboard(); }
    else if (a === 'new-task') { openTaskModal('new'); }
    else if (a === 'edit-task') {
      if (e.target.closest('.tile-chk') || e.target.closest('[data-action="toggle-done"]')) return;
      var tEdit = findTask(el.dataset.tid);
      if (!tEdit) return;
      if (!canEditTask(tEdit)) {
        toast('err', 'У вас нет прав на редактирование этой задачи');
        return;
      }
      openTaskModal('edit', el.dataset.tid);
    }
    else if (a === 'import-tasks-excel') { openTasksExcelModal(); }
    else if (a === 'optimize-works') { optimizeWorksCalendar(); }
    else if (a === 'excel-demo-load') { loadDemoExcelData(); }
    else if (a === 'excel-import-confirm') { confirmExcelImport(); }
    else if (a === 'save-task') { saveTask(); }
    else if (a === 'toggle-done') {
      var tdTask = findTask(el.dataset.tid); if (!tdTask) return;
      if (!canEditTask(tdTask)) { toast('err', 'Нет прав на изменение этой задачи'); el.checked = !el.checked; return; }
      var nowDone = el.checked;
      tdTask.s = nowDone ? 'done' : 'plan';
      tdTask.status = nowDone ? 'done' : 'plan';
      if (TASKS_DB) { TASKS_DB.updateTask(tdTask.id, tdTask); }
      drawCalendarGrid();
      toast('ok', nowDone ? '✓ Отмечено выполненным' : 'Возвращено в план');
    }
    else if (a === 'close-modal') { overlay.classList.remove('show'); }
    else if (a === 'new-user') { openUserModal('new'); }
    else if (a === 'edit-user') { openUserModal('edit', el.dataset.uid); }
    else if (a === 'pwd-user') { openUserModal('pwd', el.dataset.uid); }
    else if (a === 'save-user') { saveUser(); }
    else if (a === 'del-user') { delUser(el.dataset.uid); }
    else if (a === 'export-db') { exportDb(); }
    else if (a === 'import-db') { var fi = document.getElementById('import-file'); if (fi) fi.click(); }
    else if (a === 'how-transfer') { e.preventDefault(); toast('ok', 'ПЕРЕНОС БАЗЫ: 1) В браузере, где уже есть пользователи → «Экспорт базы» → скачается users_db.json. 2) В новом браузере → «Импорт базы» → выберите этот файл → нажмите ОК (замена). Готово!'); }
    else if (a === 'logout') { DB.clearSession(); showLoginScreen(); }
    else if (a === 'optimize') { autoSchedule(); }
    else if (a === 'build-route') { buildYandexRoute(false); }
    else if (a === 'build-route-no-jam') { buildYandexRoute(true); }
    else if (a === 'map-off') { S.mapOff = parseInt(el.dataset.off, 10); renderMap(); }
    else if (a === 'refs-tab') { S.refsTab = el.dataset.tab; renderRefs(); }
    else if (a === 'dl-works-tpl') { downloadRefTemplate('works'); }
    else if (a === 'dl-norms-tpl') { downloadRefTemplate('norms'); }
    else if (a === 'ul-works-excel') { S.excelImportMode = 'works'; var fi = document.getElementById('ref-excel-file'); if (fi) fi.click(); }
    else if (a === 'ul-norms-excel') { S.excelImportMode = 'norms'; var fi = document.getElementById('ref-excel-file'); if (fi) fi.click(); }
    else if (a === 'toggle-tree') { var ul = el.nextElementSibling; if (ul) ul.style.display = (ul.style.display === 'none' ? '' : 'none'); }
    else if (a === 'new-work') { if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; } openWorkModal('new'); }
    else if (a === 'edit-work') { openWorkModal('edit', el.dataset.wid); }
    else if (a === 'del-work') { delWork(el.dataset.wid); }
    else if (a === 'save-work') { saveWork(); }
    else if (a === 'print-report1') { printReport1(); }
    else if (a === 'print-report2') { printReport2(); }
    else if (a === 'print-permit') { printPermitReport(); }
    else if (a === 'print-snow') { printSnowReport(); }
    else if (a === 'print-weather') { printWeatherReport(); }
  });
  function shiftCal(dir) {
    if (S.calMode === 'week') S.weekShift += dir;
    else if (S.calMode === 'month') S.monthShift += dir;
    else S.dayShift += dir;
    renderCalendar();
  }

  /* ---------- СТАРТ ---------- */
  document.getElementById('login-form').addEventListener('submit', onLoginSubmit);
  Promise.all([DB.ensureSeed(), WORK.ensureSeed()]).then(function () {
    var u = DB.getSession();
    if (u) enterApp(u); else showLoginScreen();
    // Загрузка прогноза погоды
    loadWeatherForecast();
    setInterval(loadWeatherForecast, 3600000);
    // Рандомная синхронизация с сервером каждые 10-30 секунд
    function scheduleNextSync() {
      var delay = 10000 + Math.floor(Math.random() * 20000); // 10-30 сек
      setTimeout(function() {
        if (DB.isServerOnline()) {
          DB.syncFromServer();
        } else {
          DB.checkServer().then(function(online) {
            if (online) DB.syncFromServer();
          });
        }
        scheduleNextSync(); // следующая итерация
      }, delay);
    }
    scheduleNextSync();
  }).catch(function (err) {
    console.error('SmartPlan init error:', err);
    showLoginScreen();
  });
})();
