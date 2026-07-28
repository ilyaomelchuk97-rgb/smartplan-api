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
    master:  { label: 'Мастер',            cls: 'teal' },
    viewer:  { label: 'Начальник СЭОГС',   cls: 'slate' }
  };
  var AREAS = ['УБиРОГС'];

  // Базы (отправные точки маршрутов)
  var BASES = [
    { id: 'b1', name: 'г. Минск, ул. Ботаническая 11', lat: 53.9060, lng: 27.6027 },
    { id: 'b2', name: 'г. Минск, ул. Волгоградская 3А', lat: 53.8743, lng: 27.4932 }
  ];

  /* ---------- УТИЛИТЫ ДАТ ---------- */
  var TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  var WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var WD_FULL = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  var MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  var MON_NOM = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
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
    reportMonth: null, // {year, month} — выбранный отчётный месяц; null = текущий
    dashMonth: null,   // {year, month} — выбранный месяц для панели аналитики; null = текущий
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

  var CAP = 8; // ФРВ: рабочий день = 8 ч (Пн–Чт)
  function dayCapacity(off) { return offToDate(off).getDay() === 5 ? 7.25 : 8; } // Пт=7.25, остальное=8

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
    if (S.role === 'viewer') return false;                 // только просмотр
    if (S.role === 'admin') return true;                       // всё
    if (S.role === 'master') return S.user && t.m === S.user.id;         // только себя
    var m = masterById(t.m);                                   // nach / smaster — свой участок
    return !!m && S.user && m.area === S.user.area;
  }
  // Может ли пользователь перетаскивать задачи на строку этого мастера
  function canDropOn(masterId) {
    if (S.role === 'viewer') return false;                 // только просмотр
    if (S.role === 'admin') return true;
    if (S.role === 'master') return S.user && masterId === S.user.id;
    var m = masterById(masterId);
    return !!m && S.user && m.area === S.user.area;                       // nach / smaster
  }
  function visibleMasters() {
    var all = getMasters();
    if (S.role === 'admin' || S.role === 'viewer') return all;
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
      '&daily=temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,weather_code,sunrise,sunset,windspeed_10m_max' +
      '&hourly=temperature_2m,precipitation_probability,snowfall,rain,weather_code' +
      '&timezone=Europe%2FMinsk&forecast_days=15';
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
        
        // Почасовые данные (сопоставляем по дате дня — надёжнее, чем по индексу)
        var hourlyArr = [];
        if (data.hourly && data.hourly.time) {
          for (var h = 0; h < data.hourly.time.length; h++) {
            var hTime = data.hourly.time[h];
            // Сравниваем префикс даты "YYYY-MM-DD" с текущим днём
            if (hTime && hTime.indexOf(dateStr) === 0) {
              var hr = parseInt(hTime.substring(11, 13), 10);
              var t = data.hourly.temperature_2m[h];
              var hCode = data.hourly.weather_code[h] || 0;
              var hInfo = decodeWeatherCode(hCode);
              var hSnow = data.hourly.snowfall ? (data.hourly.snowfall[h] || 0) : 0;
              var hRain = data.hourly.rain ? (data.hourly.rain[h] || 0) : 0;
              var hProb = data.hourly.precipitation_probability ? (data.hourly.precipitation_probability[h] || 0) : 0;
              hourlyArr.push({
                hour: hr,
                temp: Math.round((t != null ? t : 0) * 10) / 10,
                desc: hInfo.desc,
                snow: hInfo.snow,
                snowfall: hSnow,
                rain: hRain,
                precipProb: hProb
              });
            }
          }
        }

        weatherCache[dateStr] = {
          temp: avgTemp,
          tempMax: tMax, tempMin: tMin,
          snow: snowfall > 0 || info.snow,
          snowfall: snowfall,
          rain: Math.max(0, precip - snowfall * 10), // мм дождя (снег в см → ~10мм/см)
          precip: precip,
          code: code,
          desc: info.desc,
          wind: data.daily.windspeed_10m_max ? (data.daily.windspeed_10m_max[i] || 0) : 0,
          sunrise: data.daily.sunrise[i],
          sunset: data.daily.sunset[i],
          hourly: hourlyArr
        };
      });
      weatherLoaded = true;
    });
  }

  // Запрос к Яндекс.Погоде (требует API-ключ, может блокироваться CORS)
  function loadWeatherFromYandex() {
    var lat = (window.SP_CONFIG && SP_CONFIG.weatherLat) || 53.9023;
    var lng = (window.SP_CONFIG && SP_CONFIG.weatherLng) || 27.5619;
    var apiKey = '';
    var url = 'https://api.weather.yandex.ru/v2/forecast?lat=' + lat + '&lon=' + lng + '&limit=14&hours=false&extra=true';
    return fetch(url, {
      headers: {}
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
  // Если данных с сервера нет — генерирует правдоподобные данные, чтобы UI не ломался
  function getWeatherForecast(dayOff) {
    var d = offToDate(dayOff);
    var k = key(d);
    if (weatherCache[k]) return weatherCache[k];

    // Генерация запасных данных (если API недоступен)
    var month = d.getMonth();
    var temp;
    if (month === 11 || month === 0 || month === 1) temp = -5 - Math.floor(Math.random() * 10);
    else if (month >= 2 && month <= 4) temp = 5 + Math.floor(Math.random() * 8);
    else if (month >= 5 && month <= 7) temp = 18 + Math.floor(Math.random() * 10);
    else temp = 8 + Math.floor(Math.random() * 7);

    var desc = temp < 0 ? 'Холодно' : temp > 15 ? 'Тепло' : 'Прохладно';

    // Почасовые данные (реалистичная кривая температуры: минимум ~5:00, максимум ~15:00)
    var dummyHourly = [];
    for (var h = 0; h < 24; h++) {
      var curve = Math.sin((h - 9) * Math.PI / 12);
      var hTemp = Math.round((temp + curve * 4) * 10) / 10;
      dummyHourly.push({ hour: h, temp: hTemp, desc: desc, snow: false, snowfall: 0, rain: 0, precipProb: 0 });
    }

    var dummyWf = {
      temp: temp,
      desc: desc,
      snowfall: 0,
      rain: 0,
      precip: 0,
      wind: 3,
      hourly: dummyHourly,
      sunrise: key(d) + 'T06:00',
      sunset: key(d) + 'T20:00'
    };

    weatherCache[k] = dummyWf; // Сохраняем в кэш, чтобы данные не пропадали при клике
    return dummyWf;
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
    dashboard: ['Панель мониторинга', 'Рабочий стол'],
    calendar: ['Планирование / Календарь', 'Перетаскивайте карточки: влево/вправо — смена даты, вверх/вниз — смена мастера'],
    map: ['Карта маршрутов', 'Оптимизация пути между объектами и выбор картографического сервиса'],
    gmap: ['Интерактивная карта', 'Интерактивная карта сетей и объектов УП «МИНГАЗ»'],
    perms: ['Разрешения', 'Система разрешений на производство работ'],
    refs: ['Справочники', 'Виды работ, нормы времени, объекты газоснабжения'],
    users: ['Пользователи', 'Учётные записи, роли и доступ к системе'],
    reports: ['Отчёты', 'Печатные формы для подписи у руководства'],
    aikb: ['База знаний AI', 'Правила и база знаний для AI-ассистента'],
    logs: ['Журнал действий', 'Действия пользователей системы']
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
     KPI ПОПАПЫ (Панель мониторинга)
     ===================================================================== */
  function openKpiPopup(title, color, bodyHtml) {
    var h = '<div class="modal-h" style="border-bottom:1px solid var(--line);background:' + color + ';color:#fff;"><h3 style="color:#fff">' + esc(title) + '</h3><button class="x" data-action="close-modal" style="color:#fff">×</button></div>';
    h += '<div class="modal-b">';
    h += bodyHtml || '<div class="empty">Нет данных</div>';
    h += '</div>';
    h += '<div class="modal-f"><button class="btn" data-action="close-modal">Закрыть</button></div>';
    modal.innerHTML = h;
    overlay.classList.add('show');
  }

  function kpiToday() {
    var vt = visibleTasks().filter(function (t) { return t.d === 0; });
    var body = '';
    if (!vt.length) { openKpiPopup('Задачи на сегодня', '#2563eb', null); return; }
    vt.sort(function(a,b) { return (a.m||'').localeCompare(b.m||''); });
    vt.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      body += '<div class="rz-item"><div class="rz-bar" style="background:' + (m ? m.color : '#94a3b8') + '"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">' + esc(m ? m.name : '?') + ' · ' + esc(m ? m.area : '') + ' · ' + fmtH(taskHours(t)) + ' ч' + (t.volume ? ' · Объём: ' + t.volume + ' ' + (w ? w.unit : '') : '') + '</div></div><div class="rz-dl" style="color:#2563eb">' + statusLabel(t) + '</div></div>';
    });
    openKpiPopup('Задачи на сегодня (' + vt.length + ')', '#2563eb', body);
  }

  function kpiOverloads() {
    var masters = visibleMasters();
    var overloaded = masters.filter(function (m) { return loadForDay(m.id, 0) > dayCapacity(0); });
    var body = '';
    if (!overloaded.length) { openKpiPopup('Перегрузок сегодня', '#dc2626', '<div class="empty">🎉 Перегрузок нет!</div>'); return; }
    overloaded.forEach(function (m) {
      var load = loadForDay(m.id, 0);
      var dayTasks = visibleTasks().filter(function(t) { return t.m === m.id && t.d === 0 && !isDone(t); });
      var taskList = '';
      dayTasks.forEach(function(t) { var w = workOf(t); taskList += '<div class="taskline"><span class="pill">' + esc(w ? w.name : '?') + '</span><span>' + esc(addrOf(t)) + '</span><span style="margin-left:auto;color:var(--red);font-weight:700">' + fmtH(taskHours(t)) + ' ч</span></div>'; });
      body += '<div class="today-mstr" style="border-color:var(--red);background:#fff5f5;"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div><div class="meta"><div class="h" style="color:var(--red)">' + fmtH(load) + ' ч / ' + fmtH(dayCapacity(0)) + ' ч</div><span class="tag over">⚠ +' + fmtH(load - dayCapacity(0)) + ' ч</span></div></div>';
      body += taskList;
    });
    openKpiPopup('Перегрузки сегодня (' + overloaded.length + ')', '#dc2626', body);
  }

  function kpiMonth() {
    var vt = visibleTasks().filter(function (t) { var d = offToDate(t.d); return d.getMonth() === TODAY.getMonth() && d.getFullYear() === TODAY.getFullYear(); });
    var done = vt.filter(function(t) { return isDone(t); });
    var body = '<div style="margin-bottom:12px;font-size:13px;color:var(--muted);">Выполнено: <b style="color:var(--green)">' + done.length + '</b> из <b>' + vt.length + '</b></div>';
    if (!done.length) { openKpiPopup('Выполнено за месяц', '#16a34a', null); return; }
    done.sort(function(a,b) { return b.d - a.d; });
    done.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m), d = offToDate(t.d);
      body += '<div class="rz-item"><div class="rz-bar" style="background:var(--green)"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">' + esc(m ? m.name : '?') + ' · ' + d.getDate() + ' ' + MON[d.getMonth()] + '</div></div><div class="rz-dl" style="color:var(--green)">✓ ' + fmtH(taskHours(t)) + ' ч</div></div>';
    });
    openKpiPopup('Выполнено за месяц (' + done.length + ')', '#16a34a', body);
  }

  function kpiPermits() {
    var vt = visibleTasks().filter(function (t) { return t.needs_permit && !isDone(t); });
    var body = '';
    if (!vt.length) { openKpiPopup('Ордеров истекает', '#f59e0b', '<div class="empty">Нет задач с ордерами</div>'); return; }
    vt.sort(function(a,b) { return a.dl - b.dl; });
    vt.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      var dlDate = t.dl_date || (t.dl != null ? key(offToDate(t.dl)) : '—');
      var daysLeft = t.dl != null ? t.dl : 0;
      var cls = daysLeft < 0 ? 'color:var(--red)' : daysLeft <= 3 ? 'color:var(--yellow)' : 'color:var(--green)';
      body += '<div class="rz-item"><div class="rz-bar" style="background:' + (daysLeft < 0 ? 'var(--red)' : daysLeft <= 3 ? 'var(--yellow)' : 'var(--green)') + '"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">' + esc(m ? m.name : '?') + ' · Ордер до: ' + dlDate + '</div></div><div class="rz-dl" style="' + cls + '">' + (daysLeft < 0 ? 'просрочка ' + (-daysLeft) + ' дн' : daysLeft === 0 ? 'сегодня!' : daysLeft + ' дн') + '</div></div>';
    });
    openKpiPopup('Ордера и разрешения (' + vt.length + ')', '#f59e0b', body);
  }

  /* =====================================================================
     РЕНДЕР: ДАШБОРД
     ===================================================================== */
  // Время в пути задачи (мин): из расчёта маршрута дня либо из самой задачи
  function taskTravelMin(t) {
    if (!t) return 0;
    var rt = getRouteTime(t.m, t.d);
    if (rt && rt.legs && rt.legs[t.id]) return rt.legs[t.id].min || 0;
    return (t.travelMin != null) ? t.travelMin : 0;
  }
  // Оценка времени в пути до объекта (мин), если реальный маршрут не рассчитан:
  // расстояние по прямой от базы × коэффициент дорог / ~35 км/ч.
  function estimateTravelMin(t) {
    if (!t) return 0;
    var lat = (t.lat != null) ? t.lat : null, lng = (t.lng != null) ? t.lng : null;
    if ((lat == null || lng == null) && t.o) { var o = OBJ_MAP[t.o]; if (o && o.lat && o.lng) { lat = o.lat; lng = o.lng; } }
    if (lat == null || lng == null) return 0;
    var km = distKm(currentBase(), { lat: lat, lng: lng }) * 1.4; // коэффициент извилистости дорог
    return Math.max(3, Math.round(km / 35 * 60));
  }
  // Кол-во рабочих дней (пн–пт) в месяце
  function countWorkDays(y, m) {
    var n = new Date(y, m + 1, 0).getDate(), wd = 0;
    for (var day = 1; day <= n; day++) {
      var dow = new Date(y, m, day).getDay();
      if (dow !== 0 && dow !== 6) wd++;
    }
    return wd;
  }

  // === Выбор месяца для панели аналитики дашборда ===
  var dmState = { viewYear: TODAY.getFullYear() };
  function getDashMY() {
    if (S.dashMonth) return { y: S.dashMonth.year, m: S.dashMonth.month };
    return { y: TODAY.getFullYear(), m: TODAY.getMonth() };
  }
  function dashMonthLabel() { var p = getDashMY(); return MON_NOM[p.m] + ' ' + p.y; }
  function toggleDashMonthPicker() {
    var dd = document.getElementById('dash-month-dropdown');
    if (!dd) return;
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    var p = getDashMY();
    dmState.viewYear = p.y;
    renderDashMonthPicker();
    var btn = document.querySelector('[data-action="dash-month-toggle"]');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      dd.style.top = (rect.bottom + 6) + 'px';
      dd.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 316)) + 'px';
    }
    dd.classList.add('open');
  }
  function renderDashMonthPicker() {
    var dd = document.getElementById('dash-month-dropdown');
    if (!dd) return;
    var p = getDashMY();
    var html = '<div class="rm-head">';
    html += '<button type="button" data-action="dm-prev-year">\u2039</button>';
    html += '<span class="rm-year">' + dmState.viewYear + '</span>';
    html += '<button type="button" data-action="dm-next-year">\u203a</button>';
    html += '<button type="button" class="rm-close" data-action="dm-close">\u00d7</button>';
    html += '</div><div class="rm-grid">';
    for (var mo = 0; mo < 12; mo++) {
      var isSel = (dmState.viewYear === p.y && mo === p.m);
      var isCur = (dmState.viewYear === TODAY.getFullYear() && mo === TODAY.getMonth());
      html += '<button type="button" class="rm-month' + (isSel ? ' selected' : '') + (isCur ? ' current' : '') + '" data-action="dm-pick" data-year="' + dmState.viewYear + '" data-month="' + mo + '">' + MON_NOM[mo] + '</button>';
    }
    html += '</div>';
    dd.innerHTML = html;
  }
  function pickDashMonth(year, month) {
    S.dashMonth = { year: year, month: month };
    var dd = document.getElementById('dash-month-dropdown');
    if (dd) dd.classList.remove('open');
    renderDashboard();
  }

  // Анимированная сцена погоды для карточки дашборда: солнце/луна/звёзды + облака/дождь/снег
  // Фаза луны (0=новая, 0.5=полная, 1=снова новая)
  function getMoonPhase(date) {
    var knownNewMoon = new Date('2000-01-06T18:14:00Z').getTime();
    var lunarCycle = 29.530588853 * 86400000;
    var diff = date.getTime() - knownNewMoon;
    var phase = (diff % lunarCycle) / lunarCycle;
    if (phase < 0) phase += 1;
    return phase;
  }

  // Количество капель дождя в сцене зависит от интенсивности осадков.
  // Учитываем код погоды WMO (тип дождя) и суточное количество осадков в мм.
  // Возвращает { count, dur }: count — число капель, dur — базовая скорость падения (с).
  function rainIntensity(wf) {
    var code = wf.code || 0;
    var mm = wf.rain || 0;
    var count;
    // Базовое количество по коду погоды (WMO)
    if (code === 51 || code === 56) count = 14;          // слабая морось
    else if (code === 53) count = 20;                     // умеренная морось
    else if (code === 55 || code === 57) count = 28;      // густая/сильная морось
    else if (code === 61 || code === 66 || code === 80) count = 26; // небольшой дождь/ливень
    else if (code === 63 || code === 67 || code === 81) count = 40; // умеренный дождь
    else if (code === 65 || code === 82) count = 54;      // сильный/проливной дождь
    else if (code >= 95) count = 60;                      // гроза с ливнем
    else count = 22;                                       // есть осадки, код не детализирован
    // Корректировка по количеству осадков за день (мм) — уточняет интенсивность
    if (mm > 0) {
      if (mm < 1) count = Math.min(count, 16);            // следы осадков
      else if (mm < 2.5) count = Math.max(count, 28);     // слабый
      else if (mm < 5) count = Math.max(count, 42);       // умеренный
      else if (mm < 8) count = Math.max(count, 54);       // сильный
      else count = Math.max(count, 64);                   // очень сильный/ливень
    }
    // Скорость падения капель: чем сильнее дождь, тем быстрее летят (с)
    var heavy = (code === 65 || code === 82 || code >= 95) || mm >= 5;
    var moder = (code === 63 || code === 67 || code === 81 || code === 55 || code === 57) || (mm >= 2.5 && mm < 5);
    var dur = heavy ? 0.45 : moder ? 0.6 : 0.75;
    // Морось — капель по стандарту (×1); сильный дождь/ливень/гроза — в 2 раза больше; прочий дождь — ×1.5
    var mult = heavy ? 2 : ((code >= 51 && code <= 57) ? 1 : 1.5);
    return { count: Math.round(count * mult), dur: dur };
  }

  function weatherSceneHTML(wf) {
    wf = wf || {};
    var now = new Date();
    var sr = wf.sunrise ? new Date(wf.sunrise) : null;
    var ss = wf.sunset ? new Date(wf.sunset) : null;
    if (!sr || !ss || isNaN(sr.getTime()) || isNaN(ss.getTime())) {
      sr = new Date(now); sr.setHours(6, 0, 0, 0);
      ss = new Date(now); ss.setHours(20, 0, 0, 0);
    }
    var morningEnd = new Date(sr.getTime() + 2.5 * 3600000);
    var eveningStart = new Date(ss.getTime() - 2.5 * 3600000);
    var tod;
    if (now < sr || now >= ss) tod = 'night';
    else if (now < morningEnd) tod = 'morning';
    else if (now >= eveningStart) tod = 'evening';
    else tod = 'day';
    var code = wf.code || 0, desc = wf.desc || '';
    var cloudy = (code >= 2 && code <= 3) || desc.indexOf('Облачно') !== -1;
    var hasRain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95);
    var hasSnow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    var hasStorm = code >= 95; // гроза → молнии
    var stormClouds = hasStorm || code === 65 || code === 82 || ((wf.rain || 0) >= 5); // сильный дождь/ливень/гроза → грозовые облака
    var c;
    if (tod === 'night') c = '#15233d';
    else if (tod === 'morning') c = '#f6b89c';
    else if (tod === 'evening') c = '#f0a868';
    else c = '#42a5f5';
    var sceneBg = 'linear-gradient(to right,transparent 28%,' + c + ' 58%,' + c + ' 100%)';
    var windy = (wf.wind || 0) >= 5; // средний/сильный ветер → дождь под углом + линии ветра
    var scene = '<div class="wx-scene' + (windy ? ' wx-windy' : '') + '" style="background:' + sceneBg + '">';
    var maskCss = 'position:absolute;inset:0;-webkit-mask-image:linear-gradient(to right,transparent 25%,black 55%);mask-image:linear-gradient(to right,transparent 25%,black 55%);pointer-events:none';
    // Небесное тело (чистый CSS — без эмодзи)
    if (tod === 'night') {
      scene += '<div style="' + maskCss + '">';
      for (var i = 0; i < 20; i++) scene += '<span class="wx-star" style="left:' + (28+Math.random()*70).toFixed(1) + '%;top:' + (Math.random()*70).toFixed(1) + '%;animation-delay:' + (Math.random()*2.5).toFixed(2) + 's"></span>';
      scene += '</div>';
      // Луна: фаза рисуется смещением круга-тени по расчётной фазе
      var mp = getMoonPhase(now);
      var _md = 46;
      var _shLeft = mp <= 0.5 ? -2 * mp * _md : 2 * (1 - mp) * _md;
      scene += '<span class="wx-moon" style="top:-6px;right:12px;z-index:1"><span class="wx-moon-shadow" style="left:' + _shLeft.toFixed(0) + 'px"></span></span>';
    } else {
      // Солнце: светящийся диск + вращающиеся лучи; при ясной погоде — ещё полупрозрачные толстые лучи (god rays) через весь блок
      var _sunny = !cloudy && !hasRain && !hasSnow && !hasStorm;
      if (_sunny) scene += '<div class="wx-godrays"></div>';
      var _sunCls = !_sunny ? ' dim' : (tod === 'evening' ? ' evening' : (tod === 'morning' ? ' morning' : ''));
      scene += '<span class="wx-sun-wrap' + _sunCls + '" style="top:-26px;right:6px;z-index:1"><span class="wx-sun"></span>';
      if (_sunny) scene += '<span class="wx-sun-rays"></span>';
      scene += '</span>';
    }
    // Облака (чистый CSS: основание + выпуклости, масштаб случайный)
    // Минимум 10–14 (ясная погода), при облачности/осадках/грозе — 20
    var nc = (cloudy || hasRain || hasSnow || hasStorm) ? 20 : (10 + Math.floor(Math.random() * 5));
    var _windFactor = Math.max(0.3, 1 - (wf.wind || 0) / 30);
    for (var cf = 0; cf < nc; cf++) {
      var cAnim = cf % 2 === 0 ? 'wxCloudRight' : 'wxCloudLeft';
      var cDur = (400 + Math.random() * 640) * _windFactor;
      var cScale = (0.62 + Math.random() * 0.5).toFixed(2);
      var cTop = Math.random() * 82;
      var cZ = Math.random() < 0.5 ? 0 : 2;
      var cDark = stormClouds && Math.random() < 0.5; // половина облаков — грозовые (тёмные)
      scene += '<span class="wx-cloud' + (cDark ? ' dark' : '') + '" style="top:' + cTop.toFixed(0) + '%;transform:scale(' + cScale + ');z-index:' + cZ + ';opacity:' + (cDark ? '.92' : '.78') + ';animation:' + cAnim + ' ' + cDur.toFixed(0) + 's linear infinite;animation-delay:-' + (Math.random()*cDur).toFixed(0) + 's"></span>';
    }
    // Ветер: полупрозрачные изогнутые линии, движущиеся слева направо
    if (windy) {
      var nw = 5 + Math.floor(Math.random() * 4);
      scene += '<div style="' + maskCss + '">';
      for (var wi = 0; wi < nw; wi++) {
        var wTop = Math.random() * 85;
        var wW = (30 + Math.random() * 50).toFixed(0);
        var wDur = (2 + Math.random() * 3).toFixed(1);
        scene += '<span class="wx-wind" style="top:' + wTop.toFixed(0) + '%;width:' + wW + 'px;animation:wxWindMove ' + wDur + 's linear infinite;animation-delay:-' + (Math.random() * wDur).toFixed(1) + 's"></span>';
      }
      scene += '</div>';
    }
    // Капли дождя — в горизонтальной полосе облаков (left 28–100%), падают до самого низа блока
    if (hasRain || hasStorm) {
      var ri = rainIntensity(wf);
      scene += '<div style="position:absolute;left:28%;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;-webkit-mask:linear-gradient(to right,transparent,#000 14%);mask:linear-gradient(to right,transparent,#000 14%)">';
      for (var r = 0; r < ri.count; r++) scene += '<span class="wx-drop" style="left:' + (Math.random()*100).toFixed(1) + '%;top:0;animation-delay:-' + (Math.random()*ri.dur).toFixed(2) + 's;animation-duration:' + (ri.dur+Math.random()*0.3).toFixed(2) + 's"></span>';
      scene += '</div>';
    }
    // Снежинки (чистый CSS). При ветре — анимация wxFlakeFallWind: снос вправо, амплитуда вправо ≈2× больше влево.
    if (hasSnow) {
      var _flakeAnim = windy ? 'wxFlakeFallWind' : 'wxFlakeFall';
      scene += '<div style="' + maskCss + ';z-index:3">';
      for (var sf = 0; sf < 14; sf++) scene += '<span class="wx-flake" style="left:' + (28+Math.random()*70).toFixed(1) + '%;top:0;animation-name:' + _flakeAnim + ';animation-delay:' + (Math.random()*3.5).toFixed(2) + 's;animation-duration:' + (2.5+Math.random()*2).toFixed(2) + 's"></span>';
      scene += '</div>';
    }
    // Грозовые облака: контейнер для маленьких молний, бьющих из облаков
    if (stormClouds) {
      scene += '<div class="wx-sparks" id="wx-sparks"></div>';
    }
    // Гроза: контейнеры для случайных вспышек молний (запускаются setupLightning на дашборде)
    if (hasStorm) {
      scene += '<div class="wx-flash" id="wx-flash"></div>';
      scene += '<div class="wx-bolts" id="wx-bolts"></div>';
    }
    scene += '</div>';
    return { html: scene };
  }

  /* ---------- МОЛНИИ ПРИ ГРОЗЕ (случайные вспышки с ответвлениями) ---------- */
  var wxLightningTimer = null;
  var wxStrikeHideTm = null;
  var wxSecondBoltTm = null;
  var wxSparkTimer = null;
  var wxSparkHideTm = null;
  function stopLightning() {
    if (wxLightningTimer) { clearTimeout(wxLightningTimer); wxLightningTimer = null; }
    if (wxStrikeHideTm) { clearTimeout(wxStrikeHideTm); wxStrikeHideTm = null; }
    if (wxSecondBoltTm) { clearTimeout(wxSecondBoltTm); wxSecondBoltTm = null; }
    if (wxSparkTimer) { clearTimeout(wxSparkTimer); wxSparkTimer = null; }
    if (wxSparkHideTm) { clearTimeout(wxSparkHideTm); wxSparkHideTm = null; }
    var f = document.getElementById('wx-flash'); if (f) f.classList.remove('on');
    var h = document.getElementById('wx-bolts'); if (h) h.innerHTML = '';
    var sp = document.getElementById('wx-sparks'); if (sp) sp.innerHTML = '';
  }
  // Запуск вспышек: большие молнии (гроза) и/или маленькие искры из грозовых облаков
  function setupLightning() {
    stopLightning();
    var hasBig = !!document.getElementById('wx-bolts');
    var hasSparks = !!document.getElementById('wx-sparks');
    if (!hasBig && !hasSparks) return; // грозы/ливня нет / не дашборд
    if (hasBig) {
      (function loop() {
        var delay = 2200 + Math.random() * 3800; // 2.2–6.0 c между большими разрядами
        wxLightningTimer = setTimeout(function () {
          if (!document.getElementById('wx-bolts')) { stopLightning(); return; }
          fireLightningStrike();
          loop();
        }, delay);
      })();
    }
    if (hasSparks) {
      (function sparkLoop() {
        var delay = 700 + Math.random() * 1300; // 0.7–2.0 c между маленькими молниями
        wxSparkTimer = setTimeout(function () {
          if (!document.getElementById('wx-sparks')) { stopLightning(); return; }
          sparkStrike();
          sparkLoop();
        }, delay);
      })();
    }
  }
  // Маленькая молния из грозового облака: бьёт строго из нижнего края тёмного облака
  function sparkStrike() {
    var host = document.getElementById('wx-sparks');
    if (!host) return;
    var scene = host.parentNode;
    if (!scene) return;
    var darkClouds = scene.querySelectorAll('.wx-cloud.dark');
    if (!darkClouds.length) return;
    var cloud = darkClouds[Math.floor(Math.random() * darkClouds.length)];
    var sRect = scene.getBoundingClientRect();
    var cRect = cloud.getBoundingClientRect();
    var x = (cRect.left - sRect.left) + cRect.width * (0.2 + Math.random() * 0.6);
    var y = (cRect.bottom - sRect.top) - 3;
    var len = 12 + Math.random() * 22;
    var ang = Math.PI * (0.25 + Math.random() * 0.5);
    var ex = x + Math.cos(ang) * len;
    var ey = y + Math.abs(Math.sin(ang)) * len + 6;
    var segs = 2 + Math.floor(Math.random() * 2);
    host.innerHTML = wxBoltSegments(wxJaggedPolyline(x, y, ex, ey, segs), 1.4, 1);
    if (wxSparkHideTm) clearTimeout(wxSparkHideTm);
    wxSparkHideTm = setTimeout(function () { host.innerHTML = ''; }, 90 + Math.random() * 70);
  }
  // Разряд грозы: одна молния; при удаче (35%) — вторая бьёт через 0.5 с после первой.
  function fireLightningStrike() {
    strikeOnce();
    if (Math.random() < 0.35) {
      wxSecondBoltTm = setTimeout(function () { strikeOnce(); }, 500);
    }
  }
  // Один разряд молнии: бьёт в случайном месте по всему блоку (зигзаг + ответвления),
  // кратко засвечивает сцену и самоочищается через ~0.3 с.
  function strikeOnce() {
    var host = document.getElementById('wx-bolts');
    var flash = document.getElementById('wx-flash');
    if (!host || !flash) return;
    var W = host.clientWidth || 600;
    var H = host.clientHeight || 80;
    var yellow = Math.random() < 0.2; // 20% — жёлтая вспышка и жёлтый свет
    flash.classList.toggle('yellow', yellow);
    host.classList.toggle('yellow', yellow);
    // Главная молния: старт в верхней зоне, удар в любую точку нижней части блока
    var x0 = 6 + Math.random() * Math.max(1, W - 12);
    var y0 = -10 + Math.random() * (H * 0.2);
    var x1 = 6 + Math.random() * Math.max(1, W - 12);
    var y1 = H * (0.5 + Math.random() * 0.55);
    var segs = 5 + Math.floor(Math.random() * 4);
    var main = wxJaggedPolyline(x0, y0, x1, y1, segs);
    var html = wxBoltSegments(main, 2.6, 1);
    // Ответвления («пучки») в случайных направлениях из случайных вершин
    var branches = 1 + Math.floor(Math.random() * 3);
    for (var b = 0; b < branches; b++) {
      if (main.length < 3) break;
      var vi = 1 + Math.floor(Math.random() * (main.length - 2));
      var bx = main[vi][0], by = main[vi][1];
      var ang = Math.PI + Math.random() * Math.PI;   // вниз и в любую сторону
      var len = 18 + Math.random() * 44;
      var ex = bx + Math.cos(ang) * len;
      var ey = by + Math.abs(Math.sin(ang)) * len;   // преимущественно вниз
      html += wxBoltSegments(wxJaggedPolyline(bx, by, ex, ey, 2 + Math.floor(Math.random() * 2)), 1.8, 0.8);
    }
    host.innerHTML = html;
    // Вспышка на всю сцену (перезапуск анимации)
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    if (wxStrikeHideTm) clearTimeout(wxStrikeHideTm);
    wxStrikeHideTm = setTimeout(function () {
      host.innerHTML = '';
      flash.classList.remove('on');
    }, 230 + Math.random() * 90);
  }
  // Ломаная (зигзаг) от (x0,y0) до (x1,y1) из segs сегментов с боковым дрожанием.
  function wxJaggedPolyline(x0, y0, x1, y1, segs) {
    var pts = [[x0, y0]];
    var dx = x1 - x0, dy = y1 - y0;
    var L = Math.sqrt(dx * dx + dy * dy);
    var maxJ = Math.min(40, L * 0.2);
    var pl = Math.max(1, L);
    var nx = -dy / pl, ny = dx / pl; // перпендикуляр для бокового отклонения
    for (var i = 1; i < segs; i++) {
      var t = i / segs;
      var j = (Math.random() * 2 - 1) * maxJ;
      pts.push([x0 + dx * t + nx * j, y0 + dy * t + ny * j]);
    }
    pts.push([x1, y1]);
    return pts;
  }
  // Превращает ломаную в набор наклонных светящихся полос (.wx-seg)
  function wxBoltSegments(pts, thickness, alpha) {
    var s = '';
    for (var i = 1; i < pts.length; i++) {
      var x1 = pts[i - 1][0], y1 = pts[i - 1][1], x2 = pts[i][0], y2 = pts[i][1];
      var dx = x2 - x1, dy = y2 - y1;
      var len = Math.sqrt(dx * dx + dy * dy);
      var ang = Math.atan2(dy, dx) * 180 / Math.PI;
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      s += '<i class="wx-seg" style="left:' + (mx - len / 2).toFixed(1) + 'px;top:' + (my - thickness / 2).toFixed(1) + 'px;width:' + len.toFixed(1) + 'px;height:' + thickness + 'px;opacity:' + alpha + ';transform:rotate(' + ang.toFixed(1) + 'deg)"></i>';
    }
    return s;
  }


  // 🗺 Карта погоды (RainViewer радар + слои по районам Минска на 48 часов)
  // Слои (мультивыбор, слева сверху): температура, дождь, снег, ветер, давление, пыльца.
  // Ползунок внизу: с 00:00 сегодня до 23:00 завтра. Дождь/снег подсвечиваются на карте.
  // Минский район выделен красивой светящейся окантовкой. Яндекс.Погода удалена.

  // Граница Минского района (ОSM relation 59190), упрощена до ~88 точек. Формат [lat,lng].
  var MINSK_DISTRICT_BORDER = [[53.9306,27.9145],[53.907,27.9156],[53.9038,27.8846],[53.8889,27.8964],[53.874,27.8653],[53.855,27.8865],[53.8188,27.879],[53.8221,27.9319],[53.8073,27.9619],[53.7679,27.9427],[53.7538,27.8731],[53.765,27.7832],[53.7464,27.7436],[53.734,27.7579],[53.7178,27.7083],[53.7002,27.7206],[53.6839,27.711],[53.6713,27.6534],[53.6529,27.6309],[53.6397,27.6363],[53.6271,27.5358],[53.6505,27.5193],[53.6593,27.5292],[53.6651,27.4718],[53.714,27.4453],[53.7253,27.396],[53.74,27.4168],[53.7636,27.4127],[53.7846,27.3497],[53.8033,27.3683],[53.7955,27.3291],[53.8139,27.2788],[53.8398,27.2568],[53.8473,27.2686],[53.8734,27.1985],[53.8546,27.1772],[53.8711,27.1438],[53.8626,27.0876],[53.8907,27.0668],[53.8847,27.0187],[53.9426,27.0325],[53.9477,27.077],[54.0098,27.132],[54.0036,27.1839],[54.0196,27.1991],[54.0413,27.1923],[54.0453,27.1664],[54.0669,27.1717],[54.0671,27.1898],[54.0846,27.1646],[54.0928,27.2165],[54.1361,27.2135],[54.1474,27.2536],[54.138,27.2866],[54.1487,27.2936],[54.1648,27.2739],[54.1873,27.3062],[54.2081,27.3014],[54.2331,27.338],[54.2465,27.3355],[54.236,27.3556],[54.2518,27.3673],[54.2551,27.4074],[54.2544,27.4379],[54.2379,27.4311],[54.2343,27.4475],[54.2128,27.4477],[54.1889,27.5037],[54.1962,27.568],[54.1739,27.5838],[54.1517,27.5542],[54.1218,27.5698],[54.102,27.5617],[54.0723,27.5923],[54.064,27.6533],[54.0919,27.6432],[54.1029,27.6056],[54.1146,27.6736],[54.1143,27.7076],[54.0911,27.7187],[54.0787,27.8017],[54.0463,27.7946],[54.0298,27.8491],[54.0164,27.8395],[53.9892,27.8579],[53.9927,27.8828],[53.9698,27.8788],[53.9306,27.9145]];

  // Граница города Минска (OSM relation 59195), упрощена. Формат [lat,lng].
  var MINSK_CITY_BORDER = [[53.9281,27.7406],[53.9251,27.7266],[53.9309,27.7158],[53.941,27.7452],[53.952,27.7397],[53.9555,27.7463],[53.9637,27.7387],[53.9583,27.7245],[53.9612,27.6926],[53.958,27.6852],[53.9553,27.6905],[53.9467,27.6643],[53.959,27.6302],[53.9668,27.6416],[53.961,27.6243],[53.9715,27.5955],[53.9661,27.4698],[53.9457,27.4321],[53.9131,27.41],[53.9116,27.4024],[53.9093,27.4083],[53.8916,27.4114],[53.8903,27.402],[53.9033,27.3988],[53.889,27.3991],[53.8858,27.4109],[53.8913,27.4116],[53.8797,27.4171],[53.8816,27.3997],[53.8747,27.3987],[53.872,27.374],[53.8604,27.3967],[53.8677,27.3966],[53.8696,27.4222],[53.8506,27.4349],[53.8426,27.4667],[53.8356,27.4688],[53.8408,27.4819],[53.8324,27.575],[53.8243,27.5799],[53.8241,27.5702],[53.8168,27.5708],[53.8004,27.5863],[53.8037,27.5908],[53.7938,27.5899],[53.8013,27.5996],[53.8239,27.5927],[53.8243,27.5805],[53.8323,27.576],[53.8339,27.646],[53.8444,27.6678],[53.8331,27.679],[53.826,27.6613],[53.8157,27.6551],[53.8264,27.6673],[53.8189,27.6803],[53.8088,27.6702],[53.8048,27.6894],[53.8178,27.713],[53.8311,27.6977],[53.8279,27.714],[53.8385,27.7173],[53.8235,27.7557],[53.8246,27.782],[53.839,27.7825],[53.8447,27.8159],[53.8548,27.8184],[53.86,27.7954],[53.8657,27.7939],[53.863,27.7515],[53.8694,27.7543],[53.8756,27.7745],[53.8758,27.849],[53.8993,27.8491],[53.9034,27.8296],[53.8989,27.7755],[53.9137,27.7451],[53.9193,27.7522],[53.9214,27.7428],[53.9299,27.7491],[53.9281,27.7406]];
  // Граница Минской области (OSM relation 59752), упрощена.
  var MINSK_OBLAST_BORDER = [[54.6607,28.5443],[54.6675,28.6303],[54.5726,28.6903],[54.5631,28.855],[54.5857,28.8838],[54.6089,28.8673],[54.6162,28.9004],[54.5866,29.0198],[54.6424,29.1009],[54.6407,29.2145],[54.5828,29.2062],[54.5567,29.2801],[54.5868,29.3132],[54.5831,29.4034],[54.6201,29.4355],[54.6052,29.4854],[54.4997,29.4509],[54.4666,29.3998],[54.3908,29.4446],[54.3666,29.3428],[54.3191,29.4165],[54.245,29.3356],[54.2124,29.4619],[54.1283,29.4058],[54.0971,29.4476],[54.0934,29.4223],[54.0415,29.4286],[54.0078,29.3266],[53.9187,29.3962],[53.8784,29.3683],[53.8655,29.4204],[53.8415,29.3843],[53.8166,29.3974],[53.8006,29.4928],[53.7871,29.3863],[53.7259,29.3919],[53.7453,29.3213],[53.691,29.3],[53.6562,29.1979],[53.6866,29.0992],[53.645,29.1042],[53.6378,29.0665],[53.5863,29.0846],[53.5815,28.9478],[53.5168,28.9667],[53.6031,28.8156],[53.5789,28.7062],[53.6133,28.6194],[53.5763,28.6225],[53.5777,28.5856],[53.5249,28.568],[53.4768,28.333],[53.4505,28.4046],[53.3974,28.4062],[53.3872,28.3597],[53.3532,28.3512],[53.318,28.3845],[53.321,28.4312],[53.2757,28.4223],[53.2744,28.0817],[53.2221,28.108],[53.1863,28.1856],[53.1987,28.3227],[53.1815,28.351],[53.1564,28.31],[53.1656,28.346],[53.1454,28.3414],[53.1619,28.49],[53.1085,28.5307],[53.0177,28.5297],[52.9987,28.5632],[52.9595,28.4328],[52.8926,28.4818],[52.858,28.4127],[52.8115,28.4452],[52.7596,28.3678],[52.7267,28.368],[52.6831,28.474],[52.6595,28.4375],[52.5437,28.4349],[52.4905,28.342],[52.4747,28.2021],[52.4864,28.1329],[52.5237,28.1224],[52.5146,27.9925],[52.4345,27.9544],[52.4216,27.88],[52.4724,27.6156],[52.543,27.6289],[52.5329,27.3985],[52.4927,27.3481],[52.4391,27.3624],[52.3898,27.279],[52.4192,27.1626],[52.4855,27.1262],[52.4877,27.0579],[52.5597,27.0553],[52.6155,27.0003],[52.6167,27.033],[52.6722,27.0272],[52.6757,27.0654],[52.7781,27.0095],[52.736,26.9579],[52.7682,26.8313],[52.8528,26.7556],[52.8437,26.6884],[52.8938,26.5836],[52.8421,26.5537],[52.832,26.5223],[52.8625,26.5121],[52.8097,26.4568],[52.8424,26.3887],[52.9086,26.4586],[52.9821,26.3851],[53.001,26.4608],[53.0567,26.467],[53.0601,26.5235],[53.1192,26.4691],[53.1311,26.3751],[53.2097,26.2726],[53.2606,26.3855],[53.3176,26.4028],[53.3634,26.3549],[53.4004,26.5804],[53.4984,26.5579],[53.5107,26.4935],[53.5476,26.5472],[53.5762,26.4682],[53.6274,26.4406],[53.6682,26.3596],[53.696,26.3695],[53.7057,26.3052],[53.7608,26.2619],[53.7946,26.2803],[53.8257,26.2253],[53.8284,26.2586],[53.865,26.2293],[53.8971,26.381],[53.9282,26.359],[53.953,26.4351],[53.996,26.4003],[53.9744,26.3008],[54.0581,26.3204],[54.0285,26.1651],[54.101,26.1221],[54.1484,26.1396],[54.141,26.0776],[54.1118,26.0965],[54.1537,26.0032],[54.1951,26.0457],[54.1844,26.1025],[54.2359,26.1961],[54.2137,26.3567],[54.2894,26.4251],[54.3029,26.4875],[54.4083,26.5583],[54.4232,26.6293],[54.4879,26.6565],[54.5592,26.6235],[54.5532,26.6607],[54.5887,26.6611],[54.5933,26.7012],[54.5994,26.6648],[54.6503,26.6449],[54.6586,26.5756],[54.7128,26.5376],[54.7541,26.5494],[54.8361,26.4247],[54.8247,26.3325],[54.8789,26.3653],[54.9346,26.2795],[54.9528,26.2901],[54.9652,26.346],[54.9916,26.3447],[54.942,26.5645],[54.9657,26.6136],[54.9809,26.5913],[54.958,26.7398],[55.0222,26.8992],[54.9666,26.9679],[55.0075,27.1903],[54.9961,27.2568],[54.9405,27.314],[54.9131,27.3043],[54.8576,27.3982],[54.838,27.4933],[54.8087,27.479],[54.8105,27.5552],[54.7702,27.5285],[54.7485,27.7013],[54.6811,27.6994],[54.6668,27.7404],[54.6144,27.7605],[54.6468,27.867],[54.5849,27.9814],[54.6292,28.0515],[54.6301,28.1534],[54.6545,28.1262],[54.6775,28.2048],[54.5527,28.3969],[54.6633,28.4516],[54.6607,28.5443]];

  // Регионы — выделенные участки на карте (Минск, Минский район, Минская область).
  // polygon: граница [lat,lng]; lat/lng: центр для метки и запроса погоды.
  // Выделяются только г. Минск и Минский район (окантовкой). Минская область НЕ выделяется.
  var WX_REGIONS = [
    { name: 'Минск',         border: MINSK_CITY_BORDER,     lat: 53.902, lng: 27.562 },
    { name: 'Минский район', border: MINSK_DISTRICT_BORDER, lat: 53.942, lng: 27.233 }
  ];
  // Мелкие границы внутри Минска (районы города) и Минского района (сельсоветы) — ячейки с данными погоды.
              var WX_CELLS = [
    { fi:3, lat:53.6342, lng:27.53474, border:[[53.6389,27.5387],[53.62746,27.5387],[53.6271,27.5358],[53.6389,27.52748]] },
    { fi:3, lat:53.63378, lng:27.54829, border:[[53.6389,27.5387],[53.6389,27.5587],[53.62997,27.5587],[53.62746,27.5387]] },
    { fi:3, lat:53.63503, lng:27.56816, border:[[53.6389,27.5587],[53.6389,27.5787],[53.63248,27.5787],[53.62997,27.5587]] },
    { fi:3, lat:53.63627, lng:27.58789, border:[[53.6389,27.5787],[53.6389,27.5987],[53.63499,27.5987],[53.63248,27.5787]] },
    { fi:3, lat:53.63747, lng:27.60713, border:[[53.6389,27.5987],[53.6389,27.6187],[53.63749,27.6187],[53.63499,27.5987]] },
    { fi:3, lat:53.63843, lng:27.62244, border:[[53.6389,27.6187],[53.6389,27.62992],[53.63749,27.6187]] },
    { fi:3, lat:53.64533, lng:27.53082, border:[[53.6507,27.5387],[53.6389,27.5387],[53.6389,27.52748],[53.6505,27.5193],[53.6507,27.51953]] },
    { fi:3, lat:53.6448, lng:27.5487, border:[[53.6507,27.5387],[53.6507,27.5587],[53.6389,27.5587],[53.6389,27.5387]] },
    { fi:3, lat:53.6448, lng:27.5687, border:[[53.6507,27.5587],[53.6507,27.5787],[53.6389,27.5787],[53.6389,27.5587]] },
    { fi:3, lat:53.6448, lng:27.5887, border:[[53.6507,27.5787],[53.6507,27.5987],[53.6389,27.5987],[53.6389,27.5787]] },
    { fi:3, lat:53.6448, lng:27.6087, border:[[53.6507,27.5987],[53.6507,27.6187],[53.6389,27.6187],[53.6389,27.5987]] },
    { fi:3, lat:53.64457, lng:27.6264, border:[[53.6389,27.6187],[53.6507,27.6187],[53.6507,27.6318],[53.6397,27.6363],[53.6389,27.62992]] },
    { fi:3, lat:53.66178, lng:27.51168, border:[[53.6625,27.4987],[53.6625,27.5187],[53.66036,27.5187],[53.66238,27.4987]] },
    { fi:3, lat:53.65661, lng:27.53064, border:[[53.6625,27.5187],[53.6625,27.5387],[53.6507,27.5387],[53.6507,27.51953],[53.6593,27.5292],[53.66036,27.5187]] },
    { fi:3, lat:53.6566, lng:27.5487, border:[[53.6625,27.5387],[53.6625,27.5587],[53.6507,27.5587],[53.6507,27.5387]] },
    { fi:3, lat:53.6566, lng:27.5687, border:[[53.6625,27.5587],[53.6625,27.5787],[53.6507,27.5787],[53.6507,27.5587]] },
    { fi:3, lat:53.6566, lng:27.5887, border:[[53.6625,27.5787],[53.6625,27.5987],[53.6507,27.5987],[53.6507,27.5787]] },
    { fi:3, lat:53.6566, lng:27.6087, border:[[53.6625,27.5987],[53.6625,27.6187],[53.6507,27.6187],[53.6507,27.5987]] },
    { fi:3, lat:53.6572, lng:27.62723, border:[[53.6507,27.6187],[53.6625,27.6187],[53.6625,27.6387],[53.65928,27.6387],[53.6529,27.6309],[53.6507,27.6318]] },
    { fi:3, lat:53.66143, lng:27.64001, border:[[53.6625,27.6387],[53.6625,27.64264],[53.65928,27.6387]] },
    { fi:2, lat:53.66997, lng:27.47396, border:[[53.6743,27.4787],[53.6644,27.4787],[53.6651,27.4718],[53.6743,27.46681]] },
    { fi:2, lat:53.66883, lng:27.48901, border:[[53.6743,27.4787],[53.6743,27.4987],[53.6625,27.4987],[53.6625,27.49753],[53.6644,27.4787]] },
    { fi:3, lat:53.6684, lng:27.5087, border:[[53.6743,27.4987],[53.6743,27.5187],[53.6625,27.5187],[53.6625,27.4987]] },
    { fi:3, lat:53.6684, lng:27.5287, border:[[53.6743,27.5187],[53.6743,27.5387],[53.6625,27.5387],[53.6625,27.5187]] },
    { fi:3, lat:53.6684, lng:27.5487, border:[[53.6743,27.5387],[53.6743,27.5587],[53.6625,27.5587],[53.6625,27.5387]] },
    { fi:3, lat:53.6684, lng:27.5687, border:[[53.6743,27.5587],[53.6743,27.5787],[53.6625,27.5787],[53.6625,27.5587]] },
    { fi:3, lat:53.6684, lng:27.5887, border:[[53.6743,27.5787],[53.6743,27.5987],[53.6625,27.5987],[53.6625,27.5787]] },
    { fi:3, lat:53.6684, lng:27.6087, border:[[53.6743,27.5987],[53.6743,27.6187],[53.6625,27.6187],[53.6625,27.5987]] },
    { fi:3, lat:53.6684, lng:27.6287, border:[[53.6743,27.6187],[53.6743,27.6387],[53.6625,27.6387],[53.6625,27.6187]] },
    { fi:3, lat:53.66984, lng:27.64567, border:[[53.6625,27.6387],[53.6743,27.6387],[53.6743,27.6587],[53.67246,27.6587],[53.6713,27.6534],[53.6625,27.64264]] },
    { fi:4, lat:53.67369, lng:27.6615, border:[[53.6743,27.6587],[53.6743,27.66711],[53.67246,27.6587]] },
    { fi:2, lat:53.68062, lng:27.47105, border:[[53.6861,27.4787],[53.6743,27.4787],[53.6743,27.46681],[53.6861,27.46042]] },
    { fi:2, lat:53.6802, lng:27.4887, border:[[53.6861,27.4787],[53.6861,27.4987],[53.6743,27.4987],[53.6743,27.4787]] },
    { fi:3, lat:53.6802, lng:27.5087, border:[[53.6861,27.4987],[53.6861,27.5187],[53.6743,27.5187],[53.6743,27.4987]] },
    { fi:3, lat:53.6802, lng:27.5287, border:[[53.6861,27.5187],[53.6861,27.5387],[53.6743,27.5387],[53.6743,27.5187]] },
    { fi:3, lat:53.6802, lng:27.5487, border:[[53.6861,27.5387],[53.6861,27.5587],[53.6743,27.5587],[53.6743,27.5387]] },
    { fi:3, lat:53.6802, lng:27.5687, border:[[53.6861,27.5587],[53.6861,27.5787],[53.6743,27.5787],[53.6743,27.5587]] },
    { fi:3, lat:53.6802, lng:27.5887, border:[[53.6861,27.5787],[53.6861,27.5987],[53.6743,27.5987],[53.6743,27.5787]] },
    { fi:3, lat:53.6802, lng:27.6087, border:[[53.6861,27.5987],[53.6861,27.6187],[53.6743,27.6187],[53.6743,27.5987]] },
    { fi:3, lat:53.6802, lng:27.6287, border:[[53.6861,27.6187],[53.6861,27.6387],[53.6743,27.6387],[53.6743,27.6187]] },
    { fi:3, lat:53.6802, lng:27.6487, border:[[53.6861,27.6387],[53.6861,27.6587],[53.6743,27.6587],[53.6743,27.6387]] },
    { fi:4, lat:53.68054, lng:27.66829, border:[[53.6743,27.6587],[53.6861,27.6587],[53.6861,27.6787],[53.67683,27.6787],[53.6743,27.66711]] },
    { fi:4, lat:53.68245, lng:27.68767, border:[[53.6861,27.6787],[53.6861,27.6987],[53.68121,27.6987],[53.67683,27.6787]] },
    { fi:4, lat:53.68428, lng:27.70431, border:[[53.6861,27.6987],[53.6861,27.7123],[53.6839,27.711],[53.68121,27.6987]] },
    { fi:2, lat:53.69502, lng:27.45714, border:[[53.6979,27.4587],[53.68927,27.4587],[53.6979,27.45402]] },
    { fi:2, lat:53.69206, lng:27.46881, border:[[53.6979,27.4587],[53.6979,27.4787],[53.6861,27.4787],[53.6861,27.46042],[53.68927,27.4587]] },
    { fi:2, lat:53.692, lng:27.4887, border:[[53.6979,27.4787],[53.6979,27.4987],[53.6861,27.4987],[53.6861,27.4787]] },
    { fi:3, lat:53.692, lng:27.5087, border:[[53.6979,27.4987],[53.6979,27.5187],[53.6861,27.5187],[53.6861,27.4987]] },
    { fi:3, lat:53.692, lng:27.5287, border:[[53.6979,27.5187],[53.6979,27.5387],[53.6861,27.5387],[53.6861,27.5187]] },
    { fi:3, lat:53.692, lng:27.5487, border:[[53.6979,27.5387],[53.6979,27.5587],[53.6861,27.5587],[53.6861,27.5387]] },
    { fi:3, lat:53.692, lng:27.5687, border:[[53.6979,27.5587],[53.6979,27.5787],[53.6861,27.5787],[53.6861,27.5587]] },
    { fi:3, lat:53.692, lng:27.5887, border:[[53.6979,27.5787],[53.6979,27.5987],[53.6861,27.5987],[53.6861,27.5787]] },
    { fi:3, lat:53.692, lng:27.6087, border:[[53.6979,27.5987],[53.6979,27.6187],[53.6861,27.6187],[53.6861,27.5987]] },
    { fi:3, lat:53.692, lng:27.6287, border:[[53.6979,27.6187],[53.6979,27.6387],[53.6861,27.6387],[53.6861,27.6187]] },
    { fi:3, lat:53.692, lng:27.6487, border:[[53.6979,27.6387],[53.6979,27.6587],[53.6861,27.6587],[53.6861,27.6387]] },
    { fi:4, lat:53.692, lng:27.6687, border:[[53.6979,27.6587],[53.6979,27.6787],[53.6861,27.6787],[53.6861,27.6587]] },
    { fi:4, lat:53.692, lng:27.6887, border:[[53.6979,27.6787],[53.6979,27.6987],[53.6861,27.6987],[53.6861,27.6787]] },
    { fi:4, lat:53.69239, lng:27.70734, border:[[53.6861,27.6987],[53.6979,27.6987],[53.6979,27.7187],[53.69697,27.7187],[53.6861,27.7123]] },
    { fi:2, lat:53.7046, lng:27.45455, border:[[53.7097,27.4587],[53.6979,27.4587],[53.6979,27.45402],[53.7097,27.44763]] },
    { fi:2, lat:53.7038, lng:27.4687, border:[[53.7097,27.4587],[53.7097,27.4787],[53.6979,27.4787],[53.6979,27.4587]] },
    { fi:2, lat:53.7038, lng:27.4887, border:[[53.7097,27.4787],[53.7097,27.4987],[53.6979,27.4987],[53.6979,27.4787]] },
    { fi:3, lat:53.7038, lng:27.5087, border:[[53.7097,27.4987],[53.7097,27.5187],[53.6979,27.5187],[53.6979,27.4987]] },
    { fi:3, lat:53.7038, lng:27.5287, border:[[53.7097,27.5187],[53.7097,27.5387],[53.6979,27.5387],[53.6979,27.5187]] },
    { fi:3, lat:53.7038, lng:27.5487, border:[[53.7097,27.5387],[53.7097,27.5587],[53.6979,27.5587],[53.6979,27.5387]] },
    { fi:3, lat:53.7038, lng:27.5687, border:[[53.7097,27.5587],[53.7097,27.5787],[53.6979,27.5787],[53.6979,27.5587]] },
    { fi:3, lat:53.7038, lng:27.5887, border:[[53.7097,27.5787],[53.7097,27.5987],[53.6979,27.5987],[53.6979,27.5787]] },
    { fi:3, lat:53.7038, lng:27.6087, border:[[53.7097,27.5987],[53.7097,27.6187],[53.6979,27.6187],[53.6979,27.5987]] },
    { fi:3, lat:53.7038, lng:27.6287, border:[[53.7097,27.6187],[53.7097,27.6387],[53.6979,27.6387],[53.6979,27.6187]] },
    { fi:3, lat:53.7038, lng:27.6487, border:[[53.7097,27.6387],[53.7097,27.6587],[53.6979,27.6587],[53.6979,27.6387]] },
    { fi:4, lat:53.7038, lng:27.6687, border:[[53.7097,27.6587],[53.7097,27.6787],[53.6979,27.6787],[53.6979,27.6587]] },
    { fi:4, lat:53.7038, lng:27.6887, border:[[53.7097,27.6787],[53.7097,27.6987],[53.6979,27.6987],[53.6979,27.6787]] },
    { fi:4, lat:53.70353, lng:27.70808, border:[[53.6979,27.7187],[53.6979,27.6987],[53.7097,27.6987],[53.7097,27.71396],[53.70292,27.7187]] },
    { fi:4, lat:53.70015, lng:27.71935, border:[[53.6979,27.7187],[53.70292,27.7187],[53.7002,27.7206],[53.6979,27.71925]] },
    { fi:2, lat:53.72103, lng:27.41666, border:[[53.7215,27.4187],[53.7201,27.4187],[53.7215,27.41258]] },
    { fi:2, lat:53.71942, lng:27.43077, border:[[53.7215,27.4187],[53.7215,27.4387],[53.71551,27.4387],[53.7201,27.4187]] },
    { fi:2, lat:53.71628, lng:27.44993, border:[[53.7215,27.4387],[53.7215,27.4587],[53.7097,27.4587],[53.7097,27.44763],[53.714,27.4453],[53.71551,27.4387]] },
    { fi:2, lat:53.7156, lng:27.4687, border:[[53.7215,27.4587],[53.7215,27.4787],[53.7097,27.4787],[53.7097,27.4587]] },
    { fi:2, lat:53.7156, lng:27.4887, border:[[53.7215,27.4787],[53.7215,27.4987],[53.7097,27.4987],[53.7097,27.4787]] },
    { fi:3, lat:53.7156, lng:27.5087, border:[[53.7215,27.4987],[53.7215,27.5187],[53.7097,27.5187],[53.7097,27.4987]] },
    { fi:3, lat:53.7156, lng:27.5287, border:[[53.7215,27.5187],[53.7215,27.5387],[53.7097,27.5387],[53.7097,27.5187]] },
    { fi:3, lat:53.7156, lng:27.5487, border:[[53.7215,27.5387],[53.7215,27.5587],[53.7097,27.5587],[53.7097,27.5387]] },
    { fi:3, lat:53.7156, lng:27.5687, border:[[53.7215,27.5587],[53.7215,27.5787],[53.7097,27.5787],[53.7097,27.5587]] },
    { fi:3, lat:53.7156, lng:27.5887, border:[[53.7215,27.5787],[53.7215,27.5987],[53.7097,27.5987],[53.7097,27.5787]] },
    { fi:3, lat:53.7156, lng:27.6087, border:[[53.7215,27.5987],[53.7215,27.6187],[53.7097,27.6187],[53.7097,27.5987]] },
    { fi:3, lat:53.7156, lng:27.6287, border:[[53.7215,27.6187],[53.7215,27.6387],[53.7097,27.6387],[53.7097,27.6187]] },
    { fi:3, lat:53.7156, lng:27.6487, border:[[53.7215,27.6387],[53.7215,27.6587],[53.7097,27.6587],[53.7097,27.6387]] },
    { fi:4, lat:53.7156, lng:27.6687, border:[[53.7215,27.6587],[53.7215,27.6787],[53.7097,27.6787],[53.7097,27.6587]] },
    { fi:4, lat:53.7156, lng:27.6887, border:[[53.7215,27.6787],[53.7215,27.6987],[53.7097,27.6987],[53.7097,27.6787]] },
    { fi:4, lat:53.71575, lng:27.70561, border:[[53.7097,27.6987],[53.7215,27.6987],[53.7215,27.7187],[53.7212,27.7187],[53.7178,27.7083],[53.7097,27.71396]] },
    { fi:2, lat:53.72573, lng:27.3978, border:[[53.72468,27.3987],[53.7253,27.396],[53.72721,27.3987]] },
    { fi:2, lat:53.72743, lng:27.41033, border:[[53.7333,27.4187],[53.7215,27.4187],[53.7215,27.41258],[53.72468,27.3987],[53.72721,27.3987],[53.7333,27.40732]] },
    { fi:2, lat:53.7274, lng:27.4287, border:[[53.7333,27.4187],[53.7333,27.4387],[53.7215,27.4387],[53.7215,27.4187]] },
    { fi:2, lat:53.7274, lng:27.4487, border:[[53.7333,27.4387],[53.7333,27.4587],[53.7215,27.4587],[53.7215,27.4387]] },
    { fi:2, lat:53.7274, lng:27.4687, border:[[53.7333,27.4587],[53.7333,27.4787],[53.7215,27.4787],[53.7215,27.4587]] },
    { fi:2, lat:53.7274, lng:27.4887, border:[[53.7333,27.4787],[53.7333,27.4987],[53.7215,27.4987],[53.7215,27.4787]] },
    { fi:3, lat:53.7274, lng:27.5087, border:[[53.7333,27.4987],[53.7333,27.5187],[53.7215,27.5187],[53.7215,27.4987]] },
    { fi:3, lat:53.7274, lng:27.5287, border:[[53.7333,27.5187],[53.7333,27.5387],[53.7215,27.5387],[53.7215,27.5187]] },
    { fi:3, lat:53.7274, lng:27.5487, border:[[53.7333,27.5387],[53.7333,27.5587],[53.7215,27.5587],[53.7215,27.5387]] },
    { fi:3, lat:53.7274, lng:27.5687, border:[[53.7333,27.5587],[53.7333,27.5787],[53.7215,27.5787],[53.7215,27.5587]] },
    { fi:3, lat:53.7274, lng:27.5887, border:[[53.7333,27.5787],[53.7333,27.5987],[53.7215,27.5987],[53.7215,27.5787]] },
    { fi:3, lat:53.7274, lng:27.6087, border:[[53.7333,27.5987],[53.7333,27.6187],[53.7215,27.6187],[53.7215,27.5987]] },
    { fi:3, lat:53.7274, lng:27.6287, border:[[53.7333,27.6187],[53.7333,27.6387],[53.7215,27.6387],[53.7215,27.6187]] },
    { fi:3, lat:53.7274, lng:27.6487, border:[[53.7333,27.6387],[53.7333,27.6587],[53.7215,27.6587],[53.7215,27.6387]] },
    { fi:4, lat:53.7274, lng:27.6687, border:[[53.7333,27.6587],[53.7333,27.6787],[53.7215,27.6787],[53.7215,27.6587]] },
    { fi:4, lat:53.7274, lng:27.6887, border:[[53.7333,27.6787],[53.7333,27.6987],[53.7215,27.6987],[53.7215,27.6787]] },
    { fi:4, lat:53.7274, lng:27.7087, border:[[53.7333,27.6987],[53.7333,27.7187],[53.7215,27.7187],[53.7215,27.6987]] },
    { fi:4, lat:53.72869, lng:27.72747, border:[[53.7215,27.7187],[53.7333,27.7187],[53.7333,27.7387],[53.72773,27.7387],[53.7215,27.71963]] },
    { fi:4, lat:53.73144, lng:27.74439, border:[[53.7333,27.7387],[53.7333,27.75576],[53.72773,27.7387]] },
    { fi:2, lat:53.7373, lng:27.41539, border:[[53.7451,27.4187],[53.7333,27.4187],[53.7333,27.40732],[53.74,27.4168],[53.7451,27.41591]] },
    { fi:2, lat:53.7392, lng:27.4287, border:[[53.7451,27.4187],[53.7451,27.4387],[53.7333,27.4387],[53.7333,27.4187]] },
    { fi:2, lat:53.7392, lng:27.4487, border:[[53.7451,27.4387],[53.7451,27.4587],[53.7333,27.4587],[53.7333,27.4387]] },
    { fi:2, lat:53.7392, lng:27.4687, border:[[53.7451,27.4587],[53.7451,27.4787],[53.7333,27.4787],[53.7333,27.4587]] },
    { fi:2, lat:53.7392, lng:27.4887, border:[[53.7451,27.4787],[53.7451,27.4987],[53.7333,27.4987],[53.7333,27.4787]] },
    { fi:3, lat:53.7392, lng:27.5087, border:[[53.7451,27.4987],[53.7451,27.5187],[53.7333,27.5187],[53.7333,27.4987]] },
    { fi:3, lat:53.7392, lng:27.5287, border:[[53.7451,27.5187],[53.7451,27.5387],[53.7333,27.5387],[53.7333,27.5187]] },
    { fi:3, lat:53.7392, lng:27.5487, border:[[53.7451,27.5387],[53.7451,27.5587],[53.7333,27.5587],[53.7333,27.5387]] },
    { fi:3, lat:53.7392, lng:27.5687, border:[[53.7451,27.5587],[53.7451,27.5787],[53.7333,27.5787],[53.7333,27.5587]] },
    { fi:3, lat:53.7392, lng:27.5887, border:[[53.7451,27.5787],[53.7451,27.5987],[53.7333,27.5987],[53.7333,27.5787]] },
    { fi:3, lat:53.7392, lng:27.6087, border:[[53.7451,27.5987],[53.7451,27.6187],[53.7333,27.6187],[53.7333,27.5987]] },
    { fi:3, lat:53.7392, lng:27.6287, border:[[53.7451,27.6187],[53.7451,27.6387],[53.7333,27.6387],[53.7333,27.6187]] },
    { fi:3, lat:53.7392, lng:27.6487, border:[[53.7451,27.6387],[53.7451,27.6587],[53.7333,27.6587],[53.7333,27.6387]] },
    { fi:4, lat:53.7392, lng:27.6687, border:[[53.7451,27.6587],[53.7451,27.6787],[53.7333,27.6787],[53.7333,27.6587]] },
    { fi:4, lat:53.7392, lng:27.6887, border:[[53.7451,27.6787],[53.7451,27.6987],[53.7333,27.6987],[53.7333,27.6787]] },
    { fi:4, lat:53.7392, lng:27.7087, border:[[53.7451,27.6987],[53.7451,27.7187],[53.7333,27.7187],[53.7333,27.6987]] },
    { fi:4, lat:53.7392, lng:27.7287, border:[[53.7451,27.7187],[53.7451,27.7387],[53.7333,27.7387],[53.7333,27.7187]] },
    { fi:4, lat:53.73822, lng:27.74581, border:[[53.7333,27.7387],[53.7451,27.7387],[53.7451,27.7451],[53.734,27.7579],[53.7333,27.75576]] },
    { fi:2, lat:53.75153, lng:27.41675, border:[[53.7569,27.4187],[53.7451,27.4187],[53.7451,27.41591],[53.7569,27.41386]] },
    { fi:2, lat:53.751, lng:27.4287, border:[[53.7569,27.4187],[53.7569,27.4387],[53.7451,27.4387],[53.7451,27.4187]] },
    { fi:2, lat:53.751, lng:27.4487, border:[[53.7569,27.4387],[53.7569,27.4587],[53.7451,27.4587],[53.7451,27.4387]] },
    { fi:2, lat:53.751, lng:27.4687, border:[[53.7569,27.4587],[53.7569,27.4787],[53.7451,27.4787],[53.7451,27.4587]] },
    { fi:2, lat:53.751, lng:27.4887, border:[[53.7569,27.4787],[53.7569,27.4987],[53.7451,27.4987],[53.7451,27.4787]] },
    { fi:3, lat:53.751, lng:27.5087, border:[[53.7569,27.4987],[53.7569,27.5187],[53.7451,27.5187],[53.7451,27.4987]] },
    { fi:3, lat:53.751, lng:27.5287, border:[[53.7569,27.5187],[53.7569,27.5387],[53.7451,27.5387],[53.7451,27.5187]] },
    { fi:3, lat:53.751, lng:27.5487, border:[[53.7569,27.5387],[53.7569,27.5587],[53.7451,27.5587],[53.7451,27.5387]] },
    { fi:3, lat:53.751, lng:27.5687, border:[[53.7569,27.5587],[53.7569,27.5787],[53.7451,27.5787],[53.7451,27.5587]] },
    { fi:3, lat:53.751, lng:27.5887, border:[[53.7569,27.5787],[53.7569,27.5987],[53.7451,27.5987],[53.7451,27.5787]] },
    { fi:3, lat:53.751, lng:27.6087, border:[[53.7569,27.5987],[53.7569,27.6187],[53.7451,27.6187],[53.7451,27.5987]] },
    { fi:3, lat:53.751, lng:27.6287, border:[[53.7569,27.6187],[53.7569,27.6387],[53.7451,27.6387],[53.7451,27.6187]] },
    { fi:3, lat:53.751, lng:27.6487, border:[[53.7569,27.6387],[53.7569,27.6587],[53.7451,27.6587],[53.7451,27.6387]] },
    { fi:4, lat:53.751, lng:27.6687, border:[[53.7569,27.6587],[53.7569,27.6787],[53.7451,27.6787],[53.7451,27.6587]] },
    { fi:4, lat:53.751, lng:27.6887, border:[[53.7569,27.6787],[53.7569,27.6987],[53.7451,27.6987],[53.7451,27.6787]] },
    { fi:4, lat:53.751, lng:27.7087, border:[[53.7569,27.6987],[53.7569,27.7187],[53.7451,27.7187],[53.7451,27.6987]] },
    { fi:4, lat:53.751, lng:27.7287, border:[[53.7569,27.7187],[53.7569,27.7387],[53.7451,27.7387],[53.7451,27.7187]] },
    { fi:4, lat:53.75233, lng:27.74676, border:[[53.7451,27.7387],[53.7569,27.7387],[53.7569,27.7587],[53.75349,27.7587],[53.7464,27.7436],[53.7451,27.7451]] },
    { fi:4, lat:53.75576, lng:27.76112, border:[[53.7569,27.7587],[53.7569,27.76595],[53.75349,27.7587]] },
    { fi:5, lat:53.75646, lng:27.85521, border:[[53.7569,27.8587],[53.75559,27.8587],[53.7569,27.84822]] },
    { fi:5, lat:53.7557, lng:27.8696, border:[[53.7569,27.8587],[53.7569,27.8787],[53.75493,27.8787],[53.7538,27.8731],[53.75559,27.8587]] },
    { fi:5, lat:53.75624, lng:27.88193, border:[[53.7569,27.8787],[53.7569,27.8884],[53.75493,27.8787]] },
    { fi:2, lat:53.76447, lng:27.41285, border:[[53.7687,27.3987],[53.7687,27.4187],[53.7569,27.4187],[53.7569,27.41386],[53.7636,27.4127],[53.76827,27.3987]] },
    { fi:2, lat:53.7628, lng:27.4287, border:[[53.7687,27.4187],[53.7687,27.4387],[53.7569,27.4387],[53.7569,27.4187]] },
    { fi:2, lat:53.7628, lng:27.4487, border:[[53.7687,27.4387],[53.7687,27.4587],[53.7569,27.4587],[53.7569,27.4387]] },
    { fi:2, lat:53.7628, lng:27.4687, border:[[53.7687,27.4587],[53.7687,27.4787],[53.7569,27.4787],[53.7569,27.4587]] },
    { fi:2, lat:53.7628, lng:27.4887, border:[[53.7687,27.4787],[53.7687,27.4987],[53.7569,27.4987],[53.7569,27.4787]] },
    { fi:3, lat:53.7628, lng:27.5087, border:[[53.7687,27.4987],[53.7687,27.5187],[53.7569,27.5187],[53.7569,27.4987]] },
    { fi:3, lat:53.7628, lng:27.5287, border:[[53.7687,27.5187],[53.7687,27.5387],[53.7569,27.5387],[53.7569,27.5187]] },
    { fi:3, lat:53.7628, lng:27.5487, border:[[53.7687,27.5387],[53.7687,27.5587],[53.7569,27.5587],[53.7569,27.5387]] },
    { fi:3, lat:53.7628, lng:27.5687, border:[[53.7687,27.5587],[53.7687,27.5787],[53.7569,27.5787],[53.7569,27.5587]] },
    { fi:3, lat:53.7628, lng:27.5887, border:[[53.7687,27.5787],[53.7687,27.5987],[53.7569,27.5987],[53.7569,27.5787]] },
    { fi:3, lat:53.7628, lng:27.6087, border:[[53.7687,27.5987],[53.7687,27.6187],[53.7569,27.6187],[53.7569,27.5987]] },
    { fi:3, lat:53.7628, lng:27.6287, border:[[53.7687,27.6187],[53.7687,27.6387],[53.7569,27.6387],[53.7569,27.6187]] },
    { fi:3, lat:53.7628, lng:27.6487, border:[[53.7687,27.6387],[53.7687,27.6587],[53.7569,27.6587],[53.7569,27.6387]] },
    { fi:4, lat:53.7628, lng:27.6687, border:[[53.7687,27.6587],[53.7687,27.6787],[53.7569,27.6787],[53.7569,27.6587]] },
    { fi:4, lat:53.7628, lng:27.6887, border:[[53.7687,27.6787],[53.7687,27.6987],[53.7569,27.6987],[53.7569,27.6787]] },
    { fi:4, lat:53.7628, lng:27.7087, border:[[53.7687,27.6987],[53.7687,27.7187],[53.7569,27.7187],[53.7569,27.6987]] },
    { fi:4, lat:53.7628, lng:27.7287, border:[[53.7687,27.7187],[53.7687,27.7387],[53.7569,27.7387],[53.7569,27.7187]] },
    { fi:4, lat:53.7628, lng:27.7487, border:[[53.7687,27.7387],[53.7687,27.7587],[53.7569,27.7587],[53.7569,27.7387]] },
    { fi:4, lat:53.76355, lng:27.76759, border:[[53.7569,27.7587],[53.7687,27.7587],[53.7687,27.7787],[53.76289,27.7787],[53.7569,27.76595]] },
    { fi:4, lat:53.76632, lng:27.78904, border:[[53.7687,27.7787],[53.7687,27.7987],[53.76307,27.7987],[53.765,27.7832],[53.76289,27.7787]] },
    { fi:4, lat:53.76522, lng:27.8093, border:[[53.7687,27.7987],[53.7687,27.8187],[53.76058,27.8187],[53.76307,27.7987]] },
    { fi:5, lat:53.76399, lng:27.82914, border:[[53.7687,27.8187],[53.7687,27.8387],[53.75809,27.8387],[53.76058,27.8187]] },
    { fi:5, lat:53.76293, lng:27.84887, border:[[53.7687,27.8387],[53.7687,27.8587],[53.7569,27.8587],[53.7569,27.84822],[53.75809,27.8387]] },
    { fi:5, lat:53.7628, lng:27.8687, border:[[53.7687,27.8587],[53.7687,27.8787],[53.7569,27.8787],[53.7569,27.8587]] },
    { fi:5, lat:53.76305, lng:27.88839, border:[[53.7569,27.8787],[53.7687,27.8787],[53.7687,27.8987],[53.75899,27.8987],[53.7569,27.8884]] },
    { fi:5, lat:53.76477, lng:27.90782, border:[[53.7687,27.8987],[53.7687,27.9187],[53.76304,27.9187],[53.75899,27.8987]] },
    { fi:5, lat:53.76669, lng:27.92684, border:[[53.7687,27.9187],[53.7687,27.9387],[53.76709,27.9387],[53.76304,27.9187]] },
    { fi:5, lat:53.76809, lng:27.94055, border:[[53.7687,27.9387],[53.7687,27.94309],[53.7679,27.9427],[53.76709,27.9387]] },
    { fi:2, lat:53.77864, lng:27.37313, border:[[53.7805,27.3787],[53.77493,27.3787],[53.7805,27.362]] },
    { fi:2, lat:53.77585, lng:27.38994, border:[[53.7805,27.3787],[53.7805,27.3987],[53.7687,27.3987],[53.7687,27.3974],[53.77493,27.3787]] },
    { fi:2, lat:53.7746, lng:27.4087, border:[[53.7805,27.3987],[53.7805,27.4187],[53.7687,27.4187],[53.7687,27.3987]] },
    { fi:2, lat:53.7746, lng:27.4287, border:[[53.7805,27.4187],[53.7805,27.4387],[53.7687,27.4387],[53.7687,27.4187]] },
    { fi:2, lat:53.7746, lng:27.4487, border:[[53.7805,27.4387],[53.7805,27.4587],[53.7687,27.4587],[53.7687,27.4387]] },
    { fi:2, lat:53.7746, lng:27.4687, border:[[53.7805,27.4587],[53.7805,27.4787],[53.7687,27.4787],[53.7687,27.4587]] },
    { fi:2, lat:53.7746, lng:27.4887, border:[[53.7805,27.4787],[53.7805,27.4987],[53.7687,27.4987],[53.7687,27.4787]] },
    { fi:3, lat:53.7746, lng:27.5087, border:[[53.7805,27.4987],[53.7805,27.5187],[53.7687,27.5187],[53.7687,27.4987]] },
    { fi:3, lat:53.7746, lng:27.5287, border:[[53.7805,27.5187],[53.7805,27.5387],[53.7687,27.5387],[53.7687,27.5187]] },
    { fi:3, lat:53.7746, lng:27.5487, border:[[53.7805,27.5387],[53.7805,27.5587],[53.7687,27.5587],[53.7687,27.5387]] },
    { fi:3, lat:53.7746, lng:27.5687, border:[[53.7805,27.5587],[53.7805,27.5787],[53.7687,27.5787],[53.7687,27.5587]] },
    { fi:3, lat:53.7746, lng:27.5887, border:[[53.7805,27.5787],[53.7805,27.5987],[53.7687,27.5987],[53.7687,27.5787]] },
    { fi:3, lat:53.7746, lng:27.6087, border:[[53.7805,27.5987],[53.7805,27.6187],[53.7687,27.6187],[53.7687,27.5987]] },
    { fi:3, lat:53.7746, lng:27.6287, border:[[53.7805,27.6187],[53.7805,27.6387],[53.7687,27.6387],[53.7687,27.6187]] },
    { fi:3, lat:53.7746, lng:27.6487, border:[[53.7805,27.6387],[53.7805,27.6587],[53.7687,27.6587],[53.7687,27.6387]] },
    { fi:4, lat:53.7746, lng:27.6687, border:[[53.7805,27.6587],[53.7805,27.6787],[53.7687,27.6787],[53.7687,27.6587]] },
    { fi:4, lat:53.7746, lng:27.6887, border:[[53.7805,27.6787],[53.7805,27.6987],[53.7687,27.6987],[53.7687,27.6787]] },
    { fi:4, lat:53.7746, lng:27.7087, border:[[53.7805,27.6987],[53.7805,27.7187],[53.7687,27.7187],[53.7687,27.6987]] },
    { fi:4, lat:53.7746, lng:27.7287, border:[[53.7805,27.7187],[53.7805,27.7387],[53.7687,27.7387],[53.7687,27.7187]] },
    { fi:4, lat:53.7746, lng:27.7487, border:[[53.7805,27.7387],[53.7805,27.7587],[53.7687,27.7587],[53.7687,27.7387]] },
    { fi:4, lat:53.7746, lng:27.7687, border:[[53.7805,27.7587],[53.7805,27.7787],[53.7687,27.7787],[53.7687,27.7587]] },
    { fi:4, lat:53.7746, lng:27.7887, border:[[53.7805,27.7787],[53.7805,27.7987],[53.7687,27.7987],[53.7687,27.7787]] },
    { fi:4, lat:53.7746, lng:27.8087, border:[[53.7805,27.7987],[53.7805,27.8187],[53.7687,27.8187],[53.7687,27.7987]] },
    { fi:5, lat:53.7746, lng:27.8287, border:[[53.7805,27.8187],[53.7805,27.8387],[53.7687,27.8387],[53.7687,27.8187]] },
    { fi:5, lat:53.7746, lng:27.8487, border:[[53.7805,27.8387],[53.7805,27.8587],[53.7687,27.8587],[53.7687,27.8387]] },
    { fi:5, lat:53.7746, lng:27.8687, border:[[53.7805,27.8587],[53.7805,27.8787],[53.7687,27.8787],[53.7687,27.8587]] },
    { fi:5, lat:53.7746, lng:27.8887, border:[[53.7805,27.8787],[53.7805,27.8987],[53.7687,27.8987],[53.7687,27.8787]] },
    { fi:5, lat:53.7746, lng:27.9087, border:[[53.7805,27.8987],[53.7805,27.9187],[53.7687,27.9187],[53.7687,27.8987]] },
    { fi:5, lat:53.7746, lng:27.9287, border:[[53.7805,27.9187],[53.7805,27.9387],[53.7687,27.9387],[53.7687,27.9187]] },
    { fi:5, lat:53.77538, lng:27.94252, border:[[53.7687,27.9387],[53.7805,27.9387],[53.7805,27.94884],[53.7687,27.94309]] },
    { fi:2, lat:53.78651, lng:27.35566, border:[[53.7923,27.3587],[53.7816,27.3587],[53.7846,27.3497],[53.7923,27.35736]] },
    { fi:2, lat:53.78644, lng:27.36877, border:[[53.7923,27.3587],[53.7923,27.3787],[53.7805,27.3787],[53.7805,27.362],[53.7816,27.3587]] },
    { fi:2, lat:53.7864, lng:27.3887, border:[[53.7923,27.3787],[53.7923,27.3987],[53.7805,27.3987],[53.7805,27.3787]] },
    { fi:2, lat:53.7864, lng:27.4087, border:[[53.7923,27.3987],[53.7923,27.4187],[53.7805,27.4187],[53.7805,27.3987]] },
    { fi:2, lat:53.7864, lng:27.4287, border:[[53.7923,27.4187],[53.7923,27.4387],[53.7805,27.4387],[53.7805,27.4187]] },
    { fi:2, lat:53.7864, lng:27.4487, border:[[53.7923,27.4387],[53.7923,27.4587],[53.7805,27.4587],[53.7805,27.4387]] },
    { fi:2, lat:53.7864, lng:27.4687, border:[[53.7923,27.4587],[53.7923,27.4787],[53.7805,27.4787],[53.7805,27.4587]] },
    { fi:2, lat:53.7864, lng:27.4887, border:[[53.7923,27.4787],[53.7923,27.4987],[53.7805,27.4987],[53.7805,27.4787]] },
    { fi:3, lat:53.7864, lng:27.5087, border:[[53.7923,27.4987],[53.7923,27.5187],[53.7805,27.5187],[53.7805,27.4987]] },
    { fi:3, lat:53.7864, lng:27.5287, border:[[53.7923,27.5187],[53.7923,27.5387],[53.7805,27.5387],[53.7805,27.5187]] },
    { fi:3, lat:53.7864, lng:27.5487, border:[[53.7923,27.5387],[53.7923,27.5587],[53.7805,27.5587],[53.7805,27.5387]] },
    { fi:3, lat:53.7864, lng:27.5687, border:[[53.7923,27.5587],[53.7923,27.5787],[53.7805,27.5787],[53.7805,27.5587]] },
    { fi:3, lat:53.7864, lng:27.5887, border:[[53.7923,27.5787],[53.7923,27.5987],[53.7805,27.5987],[53.7805,27.5787]] },
    { fi:3, lat:53.7864, lng:27.6087, border:[[53.7923,27.5987],[53.7923,27.6187],[53.7805,27.6187],[53.7805,27.5987]] },
    { fi:3, lat:53.7864, lng:27.6287, border:[[53.7923,27.6187],[53.7923,27.6387],[53.7805,27.6387],[53.7805,27.6187]] },
    { fi:3, lat:53.7864, lng:27.6487, border:[[53.7923,27.6387],[53.7923,27.6587],[53.7805,27.6587],[53.7805,27.6387]] },
    { fi:4, lat:53.7864, lng:27.6687, border:[[53.7923,27.6587],[53.7923,27.6787],[53.7805,27.6787],[53.7805,27.6587]] },
    { fi:4, lat:53.7864, lng:27.6887, border:[[53.7923,27.6787],[53.7923,27.6987],[53.7805,27.6987],[53.7805,27.6787]] },
    { fi:4, lat:53.7864, lng:27.7087, border:[[53.7923,27.6987],[53.7923,27.7187],[53.7805,27.7187],[53.7805,27.6987]] },
    { fi:4, lat:53.7864, lng:27.7287, border:[[53.7923,27.7187],[53.7923,27.7387],[53.7805,27.7387],[53.7805,27.7187]] },
    { fi:4, lat:53.7864, lng:27.7487, border:[[53.7923,27.7387],[53.7923,27.7587],[53.7805,27.7587],[53.7805,27.7387]] },
    { fi:4, lat:53.7864, lng:27.7687, border:[[53.7923,27.7587],[53.7923,27.7787],[53.7805,27.7787],[53.7805,27.7587]] },
    { fi:4, lat:53.7864, lng:27.7887, border:[[53.7923,27.7787],[53.7923,27.7987],[53.7805,27.7987],[53.7805,27.7787]] },
    { fi:4, lat:53.7864, lng:27.8087, border:[[53.7923,27.7987],[53.7923,27.8187],[53.7805,27.8187],[53.7805,27.7987]] },
    { fi:5, lat:53.7864, lng:27.8287, border:[[53.7923,27.8187],[53.7923,27.8387],[53.7805,27.8387],[53.7805,27.8187]] },
    { fi:5, lat:53.7864, lng:27.8487, border:[[53.7923,27.8387],[53.7923,27.8587],[53.7805,27.8587],[53.7805,27.8387]] },
    { fi:5, lat:53.7864, lng:27.8687, border:[[53.7923,27.8587],[53.7923,27.8787],[53.7805,27.8787],[53.7805,27.8587]] },
    { fi:5, lat:53.7864, lng:27.8887, border:[[53.7923,27.8787],[53.7923,27.8987],[53.7805,27.8987],[53.7805,27.8787]] },
    { fi:5, lat:53.7864, lng:27.9087, border:[[53.7923,27.8987],[53.7923,27.9187],[53.7805,27.9187],[53.7805,27.8987]] },
    { fi:5, lat:53.7864, lng:27.9287, border:[[53.7923,27.9187],[53.7923,27.9387],[53.7805,27.9387],[53.7805,27.9187]] },
    { fi:5, lat:53.78683, lng:27.94531, border:[[53.7805,27.9387],[53.7923,27.9387],[53.7923,27.95459],[53.7805,27.94884]] },
    { fi:7, lat:53.8025, lng:27.31433, border:[[53.8041,27.3187],[53.7993,27.3187],[53.8041,27.30559]] },
    { fi:7, lat:53.80045, lng:27.32917, border:[[53.8041,27.3187],[53.8041,27.3387],[53.79741,27.3387],[53.7955,27.3291],[53.7993,27.3187]] },
    { fi:8, lat:53.80161, lng:27.34729, border:[[53.8041,27.3387],[53.8041,27.3587],[53.80139,27.3587],[53.79741,27.3387]] },
    { fi:8, lat:53.79797, lng:27.36997, border:[[53.8041,27.3587],[53.8041,27.3787],[53.7923,27.3787],[53.7923,27.3587],[53.79365,27.3587],[53.8033,27.3683],[53.80139,27.3587]] },
    { fi:8, lat:53.7982, lng:27.3887, border:[[53.8041,27.3787],[53.8041,27.3987],[53.7923,27.3987],[53.7923,27.3787]] },
    { fi:8, lat:53.7982, lng:27.4087, border:[[53.8041,27.3987],[53.8041,27.4187],[53.7923,27.4187],[53.7923,27.3987]] },
    { fi:8, lat:53.7982, lng:27.4287, border:[[53.8041,27.4187],[53.8041,27.4387],[53.7923,27.4387],[53.7923,27.4187]] },
    { fi:8, lat:53.7982, lng:27.4487, border:[[53.8041,27.4387],[53.8041,27.4587],[53.7923,27.4587],[53.7923,27.4387]] },
    { fi:8, lat:53.7982, lng:27.4687, border:[[53.8041,27.4587],[53.8041,27.4787],[53.7923,27.4787],[53.7923,27.4587]] },
    { fi:8, lat:53.7982, lng:27.4887, border:[[53.8041,27.4787],[53.8041,27.4987],[53.7923,27.4987],[53.7923,27.4787]] },
    { fi:9, lat:53.7982, lng:27.5087, border:[[53.8041,27.4987],[53.8041,27.5187],[53.7923,27.5187],[53.7923,27.4987]] },
    { fi:9, lat:53.7982, lng:27.5287, border:[[53.8041,27.5187],[53.8041,27.5387],[53.7923,27.5387],[53.7923,27.5187]] },
    { fi:9, lat:53.7982, lng:27.5487, border:[[53.8041,27.5387],[53.8041,27.5587],[53.7923,27.5587],[53.7923,27.5387]] },
    { fi:9, lat:53.7982, lng:27.5687, border:[[53.8041,27.5587],[53.8041,27.5787],[53.7923,27.5787],[53.7923,27.5587]] },
    { fi:9, lat:53.7982, lng:27.5887, border:[[53.8041,27.5787],[53.8041,27.5987],[53.7923,27.5987],[53.7923,27.5787]] },
    { fi:9, lat:53.7982, lng:27.6087, border:[[53.8041,27.5987],[53.8041,27.6187],[53.7923,27.6187],[53.7923,27.5987]] },
    { fi:9, lat:53.7982, lng:27.6287, border:[[53.8041,27.6187],[53.8041,27.6387],[53.7923,27.6387],[53.7923,27.6187]] },
    { fi:9, lat:53.7982, lng:27.6487, border:[[53.8041,27.6387],[53.8041,27.6587],[53.7923,27.6587],[53.7923,27.6387]] },
    { fi:10, lat:53.7982, lng:27.6687, border:[[53.8041,27.6587],[53.8041,27.6787],[53.7923,27.6787],[53.7923,27.6587]] },
    { fi:10, lat:53.7982, lng:27.6887, border:[[53.8041,27.6787],[53.8041,27.6987],[53.7923,27.6987],[53.7923,27.6787]] },
    { fi:10, lat:53.7982, lng:27.7087, border:[[53.8041,27.6987],[53.8041,27.7187],[53.7923,27.7187],[53.7923,27.6987]] },
    { fi:10, lat:53.7982, lng:27.7287, border:[[53.8041,27.7187],[53.8041,27.7387],[53.7923,27.7387],[53.7923,27.7187]] },
    { fi:10, lat:53.7982, lng:27.7487, border:[[53.8041,27.7387],[53.8041,27.7587],[53.7923,27.7587],[53.7923,27.7387]] },
    { fi:10, lat:53.7982, lng:27.7687, border:[[53.8041,27.7587],[53.8041,27.7787],[53.7923,27.7787],[53.7923,27.7587]] },
    { fi:10, lat:53.7982, lng:27.7887, border:[[53.8041,27.7787],[53.8041,27.7987],[53.7923,27.7987],[53.7923,27.7787]] },
    { fi:10, lat:53.7982, lng:27.8087, border:[[53.8041,27.7987],[53.8041,27.8187],[53.7923,27.8187],[53.7923,27.7987]] },
    { fi:11, lat:53.7982, lng:27.8287, border:[[53.8041,27.8187],[53.8041,27.8387],[53.7923,27.8387],[53.7923,27.8187]] },
    { fi:11, lat:53.7982, lng:27.8487, border:[[53.8041,27.8387],[53.8041,27.8587],[53.7923,27.8587],[53.7923,27.8387]] },
    { fi:11, lat:53.7982, lng:27.8687, border:[[53.8041,27.8587],[53.8041,27.8787],[53.7923,27.8787],[53.7923,27.8587]] },
    { fi:11, lat:53.7982, lng:27.8887, border:[[53.8041,27.8787],[53.8041,27.8987],[53.7923,27.8987],[53.7923,27.8787]] },
    { fi:11, lat:53.7982, lng:27.9087, border:[[53.8041,27.8987],[53.8041,27.9187],[53.7923,27.9187],[53.7923,27.8987]] },
    { fi:11, lat:53.7982, lng:27.9287, border:[[53.8041,27.9187],[53.8041,27.9387],[53.7923,27.9387],[53.7923,27.9187]] },
    { fi:11, lat:53.79844, lng:27.94802, border:[[53.7923,27.9387],[53.8041,27.9387],[53.8041,27.9587],[53.80073,27.9587],[53.7923,27.95459]] },
    { fi:11, lat:53.80298, lng:27.95925, border:[[53.8041,27.9587],[53.8041,27.96034],[53.80073,27.9587]] },
    { fi:7, lat:53.81527, lng:27.27817, border:[[53.8159,27.2787],[53.81402,27.2787],[53.8159,27.2771]] },
    { fi:7, lat:53.81269, lng:27.29087, border:[[53.8159,27.2787],[53.8159,27.2987],[53.80662,27.2987],[53.8139,27.2788],[53.81402,27.2787]] },
    { fi:7, lat:53.81019, lng:27.30899, border:[[53.8159,27.2987],[53.8159,27.3187],[53.8041,27.3187],[53.8041,27.30559],[53.80662,27.2987]] },
    { fi:7, lat:53.81, lng:27.3287, border:[[53.8159,27.3187],[53.8159,27.3387],[53.8041,27.3387],[53.8041,27.3187]] },
    { fi:8, lat:53.81, lng:27.3487, border:[[53.8159,27.3387],[53.8159,27.3587],[53.8041,27.3587],[53.8041,27.3387]] },
    { fi:8, lat:53.81, lng:27.3687, border:[[53.8159,27.3587],[53.8159,27.3787],[53.8041,27.3787],[53.8041,27.3587]] },
    { fi:8, lat:53.81, lng:27.3887, border:[[53.8159,27.3787],[53.8159,27.3987],[53.8041,27.3987],[53.8041,27.3787]] },
    { fi:8, lat:53.81, lng:27.4087, border:[[53.8159,27.3987],[53.8159,27.4187],[53.8041,27.4187],[53.8041,27.3987]] },
    { fi:8, lat:53.81, lng:27.4287, border:[[53.8159,27.4187],[53.8159,27.4387],[53.8041,27.4387],[53.8041,27.4187]] },
    { fi:8, lat:53.81, lng:27.4487, border:[[53.8159,27.4387],[53.8159,27.4587],[53.8041,27.4587],[53.8041,27.4387]] },
    { fi:8, lat:53.81, lng:27.4687, border:[[53.8159,27.4587],[53.8159,27.4787],[53.8041,27.4787],[53.8041,27.4587]] },
    { fi:8, lat:53.81, lng:27.4887, border:[[53.8159,27.4787],[53.8159,27.4987],[53.8041,27.4987],[53.8041,27.4787]] },
    { fi:9, lat:53.81, lng:27.5087, border:[[53.8159,27.4987],[53.8159,27.5187],[53.8041,27.5187],[53.8041,27.4987]] },
    { fi:9, lat:53.81, lng:27.5287, border:[[53.8159,27.5187],[53.8159,27.5387],[53.8041,27.5387],[53.8041,27.5187]] },
    { fi:9, lat:53.81, lng:27.5487, border:[[53.8159,27.5387],[53.8159,27.5587],[53.8041,27.5587],[53.8041,27.5387]] },
    { fi:9, lat:53.81, lng:27.5687, border:[[53.8159,27.5587],[53.8159,27.5787],[53.8041,27.5787],[53.8041,27.5587]] },
    { fi:9, lat:53.81, lng:27.5887, border:[[53.8159,27.5787],[53.8159,27.5987],[53.8041,27.5987],[53.8041,27.5787]] },
    { fi:9, lat:53.81, lng:27.6087, border:[[53.8159,27.5987],[53.8159,27.6187],[53.8041,27.6187],[53.8041,27.5987]] },
    { fi:9, lat:53.81, lng:27.6287, border:[[53.8159,27.6187],[53.8159,27.6387],[53.8041,27.6387],[53.8041,27.6187]] },
    { fi:9, lat:53.81, lng:27.6487, border:[[53.8159,27.6387],[53.8159,27.6587],[53.8041,27.6587],[53.8041,27.6387]] },
    { fi:10, lat:53.81, lng:27.6687, border:[[53.8159,27.6587],[53.8159,27.6787],[53.8041,27.6787],[53.8041,27.6587]] },
    { fi:10, lat:53.81, lng:27.6887, border:[[53.8159,27.6787],[53.8159,27.6987],[53.8041,27.6987],[53.8041,27.6787]] },
    { fi:10, lat:53.81, lng:27.7087, border:[[53.8159,27.6987],[53.8159,27.7187],[53.8041,27.7187],[53.8041,27.6987]] },
    { fi:10, lat:53.81, lng:27.7287, border:[[53.8159,27.7187],[53.8159,27.7387],[53.8041,27.7387],[53.8041,27.7187]] },
    { fi:10, lat:53.81, lng:27.7487, border:[[53.8159,27.7387],[53.8159,27.7587],[53.8041,27.7587],[53.8041,27.7387]] },
    { fi:10, lat:53.81, lng:27.7687, border:[[53.8159,27.7587],[53.8159,27.7787],[53.8041,27.7787],[53.8041,27.7587]] },
    { fi:10, lat:53.81, lng:27.7887, border:[[53.8159,27.7787],[53.8159,27.7987],[53.8041,27.7987],[53.8041,27.7787]] },
    { fi:10, lat:53.81, lng:27.8087, border:[[53.8159,27.7987],[53.8159,27.8187],[53.8041,27.8187],[53.8041,27.7987]] },
    { fi:11, lat:53.81, lng:27.8287, border:[[53.8159,27.8187],[53.8159,27.8387],[53.8041,27.8387],[53.8041,27.8187]] },
    { fi:11, lat:53.81, lng:27.8487, border:[[53.8159,27.8387],[53.8159,27.8587],[53.8041,27.8587],[53.8041,27.8387]] },
    { fi:11, lat:53.81, lng:27.8687, border:[[53.8159,27.8587],[53.8159,27.8787],[53.8041,27.8787],[53.8041,27.8587]] },
    { fi:11, lat:53.81, lng:27.8887, border:[[53.8159,27.8787],[53.8159,27.8987],[53.8041,27.8987],[53.8041,27.8787]] },
    { fi:11, lat:53.81, lng:27.9087, border:[[53.8159,27.8987],[53.8159,27.9187],[53.8041,27.9187],[53.8041,27.8987]] },
    { fi:11, lat:53.81, lng:27.9287, border:[[53.8159,27.9187],[53.8159,27.9387],[53.8041,27.9387],[53.8041,27.9187]] },
    { fi:11, lat:53.80904, lng:27.94729, border:[[53.8041,27.9587],[53.8041,27.9387],[53.8159,27.9387],[53.8159,27.94447],[53.80888,27.9587]] },
    { fi:11, lat:53.80635, lng:27.95991, border:[[53.8041,27.9587],[53.80888,27.9587],[53.8073,27.9619],[53.8041,27.96034]] },
    { fi:7, lat:53.82329, lng:27.27476, border:[[53.8277,27.2787],[53.8159,27.2787],[53.8159,27.2771],[53.8277,27.26708]] },
    { fi:7, lat:53.8218, lng:27.2887, border:[[53.8277,27.2787],[53.8277,27.2987],[53.8159,27.2987],[53.8159,27.2787]] },
    { fi:7, lat:53.8218, lng:27.3087, border:[[53.8277,27.2987],[53.8277,27.3187],[53.8159,27.3187],[53.8159,27.2987]] },
    { fi:7, lat:53.8218, lng:27.3287, border:[[53.8277,27.3187],[53.8277,27.3387],[53.8159,27.3387],[53.8159,27.3187]] },
    { fi:8, lat:53.8218, lng:27.3487, border:[[53.8277,27.3387],[53.8277,27.3587],[53.8159,27.3587],[53.8159,27.3387]] },
    { fi:8, lat:53.8218, lng:27.3687, border:[[53.8277,27.3587],[53.8277,27.3787],[53.8159,27.3787],[53.8159,27.3587]] },
    { fi:8, lat:53.8218, lng:27.3887, border:[[53.8277,27.3787],[53.8277,27.3987],[53.8159,27.3987],[53.8159,27.3787]] },
    { fi:8, lat:53.8218, lng:27.4087, border:[[53.8277,27.3987],[53.8277,27.4187],[53.8159,27.4187],[53.8159,27.3987]] },
    { fi:8, lat:53.8218, lng:27.4287, border:[[53.8277,27.4187],[53.8277,27.4387],[53.8159,27.4387],[53.8159,27.4187]] },
    { fi:8, lat:53.8218, lng:27.4487, border:[[53.8277,27.4387],[53.8277,27.4587],[53.8159,27.4587],[53.8159,27.4387]] },
    { fi:8, lat:53.8218, lng:27.4687, border:[[53.8277,27.4587],[53.8277,27.4787],[53.8159,27.4787],[53.8159,27.4587]] },
    { fi:8, lat:53.8218, lng:27.4887, border:[[53.8277,27.4787],[53.8277,27.4987],[53.8159,27.4987],[53.8159,27.4787]] },
    { fi:9, lat:53.8218, lng:27.5087, border:[[53.8277,27.4987],[53.8277,27.5187],[53.8159,27.5187],[53.8159,27.4987]] },
    { fi:9, lat:53.8218, lng:27.5287, border:[[53.8277,27.5187],[53.8277,27.5387],[53.8159,27.5387],[53.8159,27.5187]] },
    { fi:9, lat:53.8218, lng:27.5487, border:[[53.8277,27.5387],[53.8277,27.5587],[53.8159,27.5587],[53.8159,27.5387]] },
    { fi:9, lat:53.8218, lng:27.5687, border:[[53.8277,27.5587],[53.8277,27.5787],[53.8159,27.5787],[53.8159,27.5587]] },
    { fi:9, lat:53.8218, lng:27.5887, border:[[53.8277,27.5787],[53.8277,27.5987],[53.8159,27.5987],[53.8159,27.5787]] },
    { fi:9, lat:53.8218, lng:27.6087, border:[[53.8277,27.5987],[53.8277,27.6187],[53.8159,27.6187],[53.8159,27.5987]] },
    { fi:9, lat:53.8218, lng:27.6287, border:[[53.8277,27.6187],[53.8277,27.6387],[53.8159,27.6387],[53.8159,27.6187]] },
    { fi:9, lat:53.8218, lng:27.6487, border:[[53.8277,27.6387],[53.8277,27.6587],[53.8159,27.6587],[53.8159,27.6387]] },
    { fi:10, lat:53.8218, lng:27.6687, border:[[53.8277,27.6587],[53.8277,27.6787],[53.8159,27.6787],[53.8159,27.6587]] },
    { fi:10, lat:53.8218, lng:27.6887, border:[[53.8277,27.6787],[53.8277,27.6987],[53.8159,27.6987],[53.8159,27.6787]] },
    { fi:10, lat:53.8218, lng:27.7087, border:[[53.8277,27.6987],[53.8277,27.7187],[53.8159,27.7187],[53.8159,27.6987]] },
    { fi:10, lat:53.8218, lng:27.7287, border:[[53.8277,27.7187],[53.8277,27.7387],[53.8159,27.7387],[53.8159,27.7187]] },
    { fi:10, lat:53.8218, lng:27.7487, border:[[53.8277,27.7387],[53.8277,27.7587],[53.8159,27.7587],[53.8159,27.7387]] },
    { fi:10, lat:53.8218, lng:27.7687, border:[[53.8277,27.7587],[53.8277,27.7787],[53.8159,27.7787],[53.8159,27.7587]] },
    { fi:10, lat:53.8218, lng:27.7887, border:[[53.8277,27.7787],[53.8277,27.7987],[53.8159,27.7987],[53.8159,27.7787]] },
    { fi:10, lat:53.8218, lng:27.8087, border:[[53.8277,27.7987],[53.8277,27.8187],[53.8159,27.8187],[53.8159,27.7987]] },
    { fi:11, lat:53.8218, lng:27.8287, border:[[53.8277,27.8187],[53.8277,27.8387],[53.8159,27.8387],[53.8159,27.8187]] },
    { fi:11, lat:53.8218, lng:27.8487, border:[[53.8277,27.8387],[53.8277,27.8587],[53.8159,27.8587],[53.8159,27.8387]] },
    { fi:11, lat:53.8218, lng:27.8687, border:[[53.8277,27.8587],[53.8277,27.8787],[53.8159,27.8787],[53.8159,27.8587]] },
    { fi:11, lat:53.81857, lng:27.88797, border:[[53.8159,27.8987],[53.8159,27.8787],[53.8277,27.8787],[53.8277,27.88084],[53.8188,27.879],[53.82003,27.8987]] },
    { fi:11, lat:53.81829, lng:27.90914, border:[[53.8159,27.9187],[53.8159,27.8987],[53.82003,27.8987],[53.82128,27.9187]] },
    { fi:11, lat:53.81865, lng:27.92816, border:[[53.8159,27.9387],[53.8159,27.9187],[53.82128,27.9187],[53.8221,27.9319],[53.81875,27.9387]] },
    { fi:11, lat:53.81685, lng:27.94062, border:[[53.8159,27.9387],[53.81875,27.9387],[53.8159,27.94447]] },
    { fi:7, lat:53.83885, lng:27.25815, border:[[53.8395,27.2587],[53.83756,27.2587],[53.8395,27.25705]] },
    { fi:7, lat:53.83415, lng:27.27023, border:[[53.8395,27.2587],[53.8395,27.2787],[53.8277,27.2787],[53.8277,27.26708],[53.83756,27.2587]] },
    { fi:7, lat:53.8336, lng:27.2887, border:[[53.8395,27.2787],[53.8395,27.2987],[53.8277,27.2987],[53.8277,27.2787]] },
    { fi:7, lat:53.8336, lng:27.3087, border:[[53.8395,27.2987],[53.8395,27.3187],[53.8277,27.3187],[53.8277,27.2987]] },
    { fi:7, lat:53.8336, lng:27.3287, border:[[53.8395,27.3187],[53.8395,27.3387],[53.8277,27.3387],[53.8277,27.3187]] },
    { fi:8, lat:53.8336, lng:27.3487, border:[[53.8395,27.3387],[53.8395,27.3587],[53.8277,27.3587],[53.8277,27.3387]] },
    { fi:8, lat:53.8336, lng:27.3687, border:[[53.8395,27.3587],[53.8395,27.3787],[53.8277,27.3787],[53.8277,27.3587]] },
    { fi:8, lat:53.8336, lng:27.3887, border:[[53.8395,27.3787],[53.8395,27.3987],[53.8277,27.3987],[53.8277,27.3787]] },
    { fi:8, lat:53.8336, lng:27.4087, border:[[53.8395,27.3987],[53.8395,27.4187],[53.8277,27.4187],[53.8277,27.3987]] },
    { fi:8, lat:53.8336, lng:27.4287, border:[[53.8395,27.4187],[53.8395,27.4387],[53.8277,27.4387],[53.8277,27.4187]] },
    { fi:8, lat:53.8336, lng:27.4487, border:[[53.8395,27.4387],[53.8395,27.4587],[53.8277,27.4587],[53.8277,27.4387]] },
    { fi:8, lat:53.8336, lng:27.4687, border:[[53.8395,27.4587],[53.8395,27.4787],[53.8277,27.4787],[53.8277,27.4587]] },
    { fi:8, lat:53.8336, lng:27.4887, border:[[53.8395,27.4787],[53.8395,27.4987],[53.8277,27.4987],[53.8277,27.4787]] },
    { fi:9, lat:53.8336, lng:27.5087, border:[[53.8395,27.4987],[53.8395,27.5187],[53.8277,27.5187],[53.8277,27.4987]] },
    { fi:9, lat:53.8336, lng:27.5287, border:[[53.8395,27.5187],[53.8395,27.5387],[53.8277,27.5387],[53.8277,27.5187]] },
    { fi:9, lat:53.8336, lng:27.5487, border:[[53.8395,27.5387],[53.8395,27.5587],[53.8277,27.5587],[53.8277,27.5387]] },
    { fi:9, lat:53.8336, lng:27.5687, border:[[53.8395,27.5587],[53.8395,27.5787],[53.8277,27.5787],[53.8277,27.5587]] },
    { fi:9, lat:53.8336, lng:27.5887, border:[[53.8395,27.5787],[53.8395,27.5987],[53.8277,27.5987],[53.8277,27.5787]] },
    { fi:9, lat:53.8336, lng:27.6087, border:[[53.8395,27.5987],[53.8395,27.6187],[53.8277,27.6187],[53.8277,27.5987]] },
    { fi:9, lat:53.8336, lng:27.6287, border:[[53.8395,27.6187],[53.8395,27.6387],[53.8277,27.6387],[53.8277,27.6187]] },
    { fi:9, lat:53.8336, lng:27.6487, border:[[53.8395,27.6387],[53.8395,27.6587],[53.8277,27.6587],[53.8277,27.6387]] },
    { fi:10, lat:53.8336, lng:27.6687, border:[[53.8395,27.6587],[53.8395,27.6787],[53.8277,27.6787],[53.8277,27.6587]] },
    { fi:10, lat:53.8336, lng:27.6887, border:[[53.8395,27.6787],[53.8395,27.6987],[53.8277,27.6987],[53.8277,27.6787]] },
    { fi:10, lat:53.8336, lng:27.7087, border:[[53.8395,27.6987],[53.8395,27.7187],[53.8277,27.7187],[53.8277,27.6987]] },
    { fi:10, lat:53.8336, lng:27.7287, border:[[53.8395,27.7187],[53.8395,27.7387],[53.8277,27.7387],[53.8277,27.7187]] },
    { fi:10, lat:53.8336, lng:27.7487, border:[[53.8395,27.7387],[53.8395,27.7587],[53.8277,27.7587],[53.8277,27.7387]] },
    { fi:10, lat:53.8336, lng:27.7687, border:[[53.8395,27.7587],[53.8395,27.7787],[53.8277,27.7787],[53.8277,27.7587]] },
    { fi:10, lat:53.8336, lng:27.7887, border:[[53.8395,27.7787],[53.8395,27.7987],[53.8277,27.7987],[53.8277,27.7787]] },
    { fi:10, lat:53.8336, lng:27.8087, border:[[53.8395,27.7987],[53.8395,27.8187],[53.8277,27.8187],[53.8277,27.7987]] },
    { fi:11, lat:53.8336, lng:27.8287, border:[[53.8395,27.8187],[53.8395,27.8387],[53.8277,27.8387],[53.8277,27.8187]] },
    { fi:11, lat:53.8336, lng:27.8487, border:[[53.8395,27.8387],[53.8395,27.8587],[53.8277,27.8587],[53.8277,27.8387]] },
    { fi:11, lat:53.8336, lng:27.8687, border:[[53.8395,27.8587],[53.8395,27.8787],[53.8277,27.8787],[53.8277,27.8587]] },
    { fi:11, lat:53.83431, lng:27.88046, border:[[53.8277,27.8787],[53.8395,27.8787],[53.8395,27.88329],[53.8277,27.88084]] },
    { fi:7, lat:53.84003, lng:27.25799, border:[[53.8395,27.2587],[53.8395,27.25705],[53.8398,27.2568],[53.84101,27.2587]] },
    { fi:7, lat:53.84513, lng:27.27047, border:[[53.8513,27.2587],[53.8513,27.2787],[53.8395,27.2787],[53.8395,27.2587],[53.84101,27.2587],[53.8473,27.2686],[53.85099,27.2587]] },
    { fi:7, lat:53.8454, lng:27.2887, border:[[53.8513,27.2787],[53.8513,27.2987],[53.8395,27.2987],[53.8395,27.2787]] },
    { fi:7, lat:53.8454, lng:27.3087, border:[[53.8513,27.2987],[53.8513,27.3187],[53.8395,27.3187],[53.8395,27.2987]] },
    { fi:7, lat:53.8454, lng:27.3287, border:[[53.8513,27.3187],[53.8513,27.3387],[53.8395,27.3387],[53.8395,27.3187]] },
    { fi:8, lat:53.8454, lng:27.3487, border:[[53.8513,27.3387],[53.8513,27.3587],[53.8395,27.3587],[53.8395,27.3387]] },
    { fi:8, lat:53.8454, lng:27.3687, border:[[53.8513,27.3587],[53.8513,27.3787],[53.8395,27.3787],[53.8395,27.3587]] },
    { fi:8, lat:53.8454, lng:27.3887, border:[[53.8513,27.3787],[53.8513,27.3987],[53.8395,27.3987],[53.8395,27.3787]] },
    { fi:8, lat:53.8454, lng:27.4087, border:[[53.8513,27.3987],[53.8513,27.4187],[53.8395,27.4187],[53.8395,27.3987]] },
    { fi:8, lat:53.8454, lng:27.4287, border:[[53.8513,27.4187],[53.8513,27.4387],[53.8395,27.4387],[53.8395,27.4187]] },
    { fi:8, lat:53.8454, lng:27.4487, border:[[53.8513,27.4387],[53.8513,27.4587],[53.8395,27.4587],[53.8395,27.4387]] },
    { fi:8, lat:53.8454, lng:27.4687, border:[[53.8513,27.4587],[53.8513,27.4787],[53.8395,27.4787],[53.8395,27.4587]] },
    { fi:8, lat:53.8454, lng:27.4887, border:[[53.8513,27.4787],[53.8513,27.4987],[53.8395,27.4987],[53.8395,27.4787]] },
    { fi:9, lat:53.8454, lng:27.5087, border:[[53.8513,27.4987],[53.8513,27.5187],[53.8395,27.5187],[53.8395,27.4987]] },
    { fi:9, lat:53.8454, lng:27.5287, border:[[53.8513,27.5187],[53.8513,27.5387],[53.8395,27.5387],[53.8395,27.5187]] },
    { fi:9, lat:53.8454, lng:27.5487, border:[[53.8513,27.5387],[53.8513,27.5587],[53.8395,27.5587],[53.8395,27.5387]] },
    { fi:9, lat:53.8454, lng:27.5687, border:[[53.8513,27.5587],[53.8513,27.5787],[53.8395,27.5787],[53.8395,27.5587]] },
    { fi:9, lat:53.8454, lng:27.5887, border:[[53.8513,27.5787],[53.8513,27.5987],[53.8395,27.5987],[53.8395,27.5787]] },
    { fi:9, lat:53.8454, lng:27.6087, border:[[53.8513,27.5987],[53.8513,27.6187],[53.8395,27.6187],[53.8395,27.5987]] },
    { fi:9, lat:53.8454, lng:27.6287, border:[[53.8513,27.6187],[53.8513,27.6387],[53.8395,27.6387],[53.8395,27.6187]] },
    { fi:9, lat:53.8454, lng:27.6487, border:[[53.8513,27.6387],[53.8513,27.6587],[53.8395,27.6587],[53.8395,27.6387]] },
    { fi:10, lat:53.8454, lng:27.6687, border:[[53.8513,27.6587],[53.8513,27.6787],[53.8395,27.6787],[53.8395,27.6587]] },
    { fi:10, lat:53.8454, lng:27.6887, border:[[53.8513,27.6787],[53.8513,27.6987],[53.8395,27.6987],[53.8395,27.6787]] },
    { fi:10, lat:53.8454, lng:27.7087, border:[[53.8513,27.6987],[53.8513,27.7187],[53.8395,27.7187],[53.8395,27.6987]] },
    { fi:10, lat:53.8454, lng:27.7287, border:[[53.8513,27.7187],[53.8513,27.7387],[53.8395,27.7387],[53.8395,27.7187]] },
    { fi:10, lat:53.8454, lng:27.7487, border:[[53.8513,27.7387],[53.8513,27.7587],[53.8395,27.7587],[53.8395,27.7387]] },
    { fi:10, lat:53.8454, lng:27.7687, border:[[53.8513,27.7587],[53.8513,27.7787],[53.8395,27.7787],[53.8395,27.7587]] },
    { fi:10, lat:53.8454, lng:27.7887, border:[[53.8513,27.7787],[53.8513,27.7987],[53.8395,27.7987],[53.8395,27.7787]] },
    { fi:10, lat:53.8454, lng:27.8087, border:[[53.8513,27.7987],[53.8513,27.8187],[53.8395,27.8187],[53.8395,27.7987]] },
    { fi:11, lat:53.8454, lng:27.8287, border:[[53.8513,27.8187],[53.8513,27.8387],[53.8395,27.8387],[53.8395,27.8187]] },
    { fi:11, lat:53.8454, lng:27.8487, border:[[53.8513,27.8387],[53.8513,27.8587],[53.8395,27.8587],[53.8395,27.8387]] },
    { fi:11, lat:53.8454, lng:27.8687, border:[[53.8513,27.8587],[53.8513,27.8787],[53.8395,27.8787],[53.8395,27.8587]] },
    { fi:11, lat:53.84581, lng:27.88165, border:[[53.8395,27.8787],[53.8513,27.8787],[53.8513,27.88573],[53.8395,27.88329]] },
    { fi:6, lat:53.86011, lng:27.17236, border:[[53.8631,27.1787],[53.85592,27.1787],[53.8546,27.1772],[53.8631,27.15999]] },
    { fi:7, lat:53.86071, lng:27.18141, border:[[53.8631,27.1787],[53.8631,27.18683],[53.85592,27.1787]] },
    { fi:7, lat:53.86154, lng:27.23452, border:[[53.8631,27.2387],[53.85843,27.2387],[53.8631,27.22616]] },
    { fi:7, lat:53.85864, lng:27.25017, border:[[53.8631,27.2387],[53.8631,27.2587],[53.8513,27.2587],[53.8513,27.25786],[53.85843,27.2387]] },
    { fi:7, lat:53.8572, lng:27.2687, border:[[53.8631,27.2587],[53.8631,27.2787],[53.8513,27.2787],[53.8513,27.2587]] },
    { fi:7, lat:53.8572, lng:27.2887, border:[[53.8631,27.2787],[53.8631,27.2987],[53.8513,27.2987],[53.8513,27.2787]] },
    { fi:7, lat:53.8572, lng:27.3087, border:[[53.8631,27.2987],[53.8631,27.3187],[53.8513,27.3187],[53.8513,27.2987]] },
    { fi:7, lat:53.8572, lng:27.3287, border:[[53.8631,27.3187],[53.8631,27.3387],[53.8513,27.3387],[53.8513,27.3187]] },
    { fi:8, lat:53.8572, lng:27.3487, border:[[53.8631,27.3387],[53.8631,27.3587],[53.8513,27.3587],[53.8513,27.3387]] },
    { fi:8, lat:53.8572, lng:27.3687, border:[[53.8631,27.3587],[53.8631,27.3787],[53.8513,27.3787],[53.8513,27.3587]] },
    { fi:8, lat:53.8572, lng:27.3887, border:[[53.8631,27.3787],[53.8631,27.3987],[53.8513,27.3987],[53.8513,27.3787]] },
    { fi:8, lat:53.8572, lng:27.4087, border:[[53.8631,27.3987],[53.8631,27.4187],[53.8513,27.4187],[53.8513,27.3987]] },
    { fi:8, lat:53.8572, lng:27.4287, border:[[53.8631,27.4187],[53.8631,27.4387],[53.8513,27.4387],[53.8513,27.4187]] },
    { fi:8, lat:53.8572, lng:27.4487, border:[[53.8631,27.4387],[53.8631,27.4587],[53.8513,27.4587],[53.8513,27.4387]] },
    { fi:8, lat:53.8572, lng:27.4687, border:[[53.8631,27.4587],[53.8631,27.4787],[53.8513,27.4787],[53.8513,27.4587]] },
    { fi:8, lat:53.8572, lng:27.4887, border:[[53.8631,27.4787],[53.8631,27.4987],[53.8513,27.4987],[53.8513,27.4787]] },
    { fi:9, lat:53.8572, lng:27.5087, border:[[53.8631,27.4987],[53.8631,27.5187],[53.8513,27.5187],[53.8513,27.4987]] },
    { fi:9, lat:53.8572, lng:27.5287, border:[[53.8631,27.5187],[53.8631,27.5387],[53.8513,27.5387],[53.8513,27.5187]] },
    { fi:9, lat:53.8572, lng:27.5487, border:[[53.8631,27.5387],[53.8631,27.5587],[53.8513,27.5587],[53.8513,27.5387]] },
    { fi:9, lat:53.8572, lng:27.5687, border:[[53.8631,27.5587],[53.8631,27.5787],[53.8513,27.5787],[53.8513,27.5587]] },
    { fi:9, lat:53.8572, lng:27.5887, border:[[53.8631,27.5787],[53.8631,27.5987],[53.8513,27.5987],[53.8513,27.5787]] },
    { fi:9, lat:53.8572, lng:27.6087, border:[[53.8631,27.5987],[53.8631,27.6187],[53.8513,27.6187],[53.8513,27.5987]] },
    { fi:9, lat:53.8572, lng:27.6287, border:[[53.8631,27.6187],[53.8631,27.6387],[53.8513,27.6387],[53.8513,27.6187]] },
    { fi:9, lat:53.8572, lng:27.6487, border:[[53.8631,27.6387],[53.8631,27.6587],[53.8513,27.6587],[53.8513,27.6387]] },
    { fi:10, lat:53.8572, lng:27.6687, border:[[53.8631,27.6587],[53.8631,27.6787],[53.8513,27.6787],[53.8513,27.6587]] },
    { fi:10, lat:53.8572, lng:27.6887, border:[[53.8631,27.6787],[53.8631,27.6987],[53.8513,27.6987],[53.8513,27.6787]] },
    { fi:10, lat:53.8572, lng:27.7087, border:[[53.8631,27.6987],[53.8631,27.7187],[53.8513,27.7187],[53.8513,27.6987]] },
    { fi:10, lat:53.8572, lng:27.7287, border:[[53.8631,27.7187],[53.8631,27.7387],[53.8513,27.7387],[53.8513,27.7187]] },
    { fi:10, lat:53.8572, lng:27.7487, border:[[53.8631,27.7387],[53.8631,27.7587],[53.8513,27.7587],[53.8513,27.7387]] },
    { fi:10, lat:53.8572, lng:27.7687, border:[[53.8631,27.7587],[53.8631,27.7787],[53.8513,27.7787],[53.8513,27.7587]] },
    { fi:10, lat:53.8572, lng:27.7887, border:[[53.8631,27.7787],[53.8631,27.7987],[53.8513,27.7987],[53.8513,27.7787]] },
    { fi:10, lat:53.8572, lng:27.8087, border:[[53.8631,27.7987],[53.8631,27.8187],[53.8513,27.8187],[53.8513,27.7987]] },
    { fi:11, lat:53.8572, lng:27.8287, border:[[53.8631,27.8187],[53.8631,27.8387],[53.8513,27.8387],[53.8513,27.8187]] },
    { fi:11, lat:53.8572, lng:27.8487, border:[[53.8631,27.8387],[53.8631,27.8587],[53.8513,27.8587],[53.8513,27.8387]] },
    { fi:11, lat:53.85718, lng:27.86867, border:[[53.8513,27.8787],[53.8513,27.8587],[53.8631,27.8587],[53.8631,27.87746],[53.86199,27.8787]] },
    { fi:11, lat:53.85525, lng:27.88186, border:[[53.8513,27.8787],[53.86199,27.8787],[53.855,27.8865],[53.8513,27.88573]] },
    { fi:6, lat:53.86969, lng:27.09044, border:[[53.8631,27.08723],[53.87462,27.0787],[53.8749,27.0787],[53.8749,27.0987],[53.86428,27.0987],[53.8631,27.09091]] },
    { fi:6, lat:53.8703, lng:27.10815, border:[[53.8749,27.0987],[53.8749,27.1187],[53.8673,27.1187],[53.86428,27.0987]] },
    { fi:6, lat:53.8718, lng:27.12787, border:[[53.8749,27.1187],[53.8749,27.1387],[53.87033,27.1387],[53.8673,27.1187]] },
    { fi:6, lat:53.87117, lng:27.15066, border:[[53.8749,27.1387],[53.8749,27.1587],[53.86374,27.1587],[53.8711,27.1438],[53.87033,27.1387]] },
    { fi:6, lat:53.86901, lng:27.16872, border:[[53.8749,27.1587],[53.8749,27.1787],[53.8631,27.1787],[53.8631,27.15999],[53.86374,27.1587]] },
    { fi:7, lat:53.86986, lng:27.18654, border:[[53.8631,27.1787],[53.8749,27.1787],[53.8749,27.1987],[53.87333,27.1987],[53.8734,27.1985],[53.8631,27.18683]] },
    { fi:7, lat:53.87182, lng:27.21104, border:[[53.8749,27.1987],[53.8749,27.2187],[53.86588,27.2187],[53.87333,27.1987]] },
    { fi:7, lat:53.86923, lng:27.22905, border:[[53.8749,27.2187],[53.8749,27.2387],[53.8631,27.2387],[53.8631,27.22616],[53.86588,27.2187]] },
    { fi:7, lat:53.869, lng:27.2487, border:[[53.8749,27.2387],[53.8749,27.2587],[53.8631,27.2587],[53.8631,27.2387]] },
    { fi:7, lat:53.869, lng:27.2687, border:[[53.8749,27.2587],[53.8749,27.2787],[53.8631,27.2787],[53.8631,27.2587]] },
    { fi:7, lat:53.869, lng:27.2887, border:[[53.8749,27.2787],[53.8749,27.2987],[53.8631,27.2987],[53.8631,27.2787]] },
    { fi:7, lat:53.869, lng:27.3087, border:[[53.8749,27.2987],[53.8749,27.3187],[53.8631,27.3187],[53.8631,27.2987]] },
    { fi:7, lat:53.869, lng:27.3287, border:[[53.8749,27.3187],[53.8749,27.3387],[53.8631,27.3387],[53.8631,27.3187]] },
    { fi:8, lat:53.869, lng:27.3487, border:[[53.8749,27.3387],[53.8749,27.3587],[53.8631,27.3587],[53.8631,27.3387]] },
    { fi:8, lat:53.869, lng:27.3687, border:[[53.8749,27.3587],[53.8749,27.3787],[53.8631,27.3787],[53.8631,27.3587]] },
    { fi:8, lat:53.869, lng:27.3887, border:[[53.8749,27.3787],[53.8749,27.3987],[53.8631,27.3987],[53.8631,27.3787]] },
    { fi:8, lat:53.869, lng:27.4087, border:[[53.8749,27.3987],[53.8749,27.4187],[53.8631,27.4187],[53.8631,27.3987]] },
    { fi:8, lat:53.869, lng:27.4287, border:[[53.8749,27.4187],[53.8749,27.4387],[53.8631,27.4387],[53.8631,27.4187]] },
    { fi:8, lat:53.869, lng:27.4487, border:[[53.8749,27.4387],[53.8749,27.4587],[53.8631,27.4587],[53.8631,27.4387]] },
    { fi:8, lat:53.869, lng:27.4687, border:[[53.8749,27.4587],[53.8749,27.4787],[53.8631,27.4787],[53.8631,27.4587]] },
    { fi:8, lat:53.869, lng:27.4887, border:[[53.8749,27.4787],[53.8749,27.4987],[53.8631,27.4987],[53.8631,27.4787]] },
    { fi:9, lat:53.869, lng:27.5087, border:[[53.8749,27.4987],[53.8749,27.5187],[53.8631,27.5187],[53.8631,27.4987]] },
    { fi:9, lat:53.869, lng:27.5287, border:[[53.8749,27.5187],[53.8749,27.5387],[53.8631,27.5387],[53.8631,27.5187]] },
    { fi:9, lat:53.869, lng:27.5487, border:[[53.8749,27.5387],[53.8749,27.5587],[53.8631,27.5587],[53.8631,27.5387]] },
    { fi:9, lat:53.869, lng:27.5687, border:[[53.8749,27.5587],[53.8749,27.5787],[53.8631,27.5787],[53.8631,27.5587]] },
    { fi:9, lat:53.869, lng:27.5887, border:[[53.8749,27.5787],[53.8749,27.5987],[53.8631,27.5987],[53.8631,27.5787]] },
    { fi:9, lat:53.869, lng:27.6087, border:[[53.8749,27.5987],[53.8749,27.6187],[53.8631,27.6187],[53.8631,27.5987]] },
    { fi:9, lat:53.869, lng:27.6287, border:[[53.8749,27.6187],[53.8749,27.6387],[53.8631,27.6387],[53.8631,27.6187]] },
    { fi:9, lat:53.869, lng:27.6487, border:[[53.8749,27.6387],[53.8749,27.6587],[53.8631,27.6587],[53.8631,27.6387]] },
    { fi:10, lat:53.869, lng:27.6687, border:[[53.8749,27.6587],[53.8749,27.6787],[53.8631,27.6787],[53.8631,27.6587]] },
    { fi:10, lat:53.869, lng:27.6887, border:[[53.8749,27.6787],[53.8749,27.6987],[53.8631,27.6987],[53.8631,27.6787]] },
    { fi:10, lat:53.869, lng:27.7087, border:[[53.8749,27.6987],[53.8749,27.7187],[53.8631,27.7187],[53.8631,27.6987]] },
    { fi:10, lat:53.869, lng:27.7287, border:[[53.8749,27.7187],[53.8749,27.7387],[53.8631,27.7387],[53.8631,27.7187]] },
    { fi:10, lat:53.869, lng:27.7487, border:[[53.8749,27.7387],[53.8749,27.7587],[53.8631,27.7587],[53.8631,27.7387]] },
    { fi:10, lat:53.869, lng:27.7687, border:[[53.8749,27.7587],[53.8749,27.7787],[53.8631,27.7787],[53.8631,27.7587]] },
    { fi:10, lat:53.869, lng:27.7887, border:[[53.8749,27.7787],[53.8749,27.7987],[53.8631,27.7987],[53.8631,27.7787]] },
    { fi:10, lat:53.869, lng:27.8087, border:[[53.8749,27.7987],[53.8749,27.8187],[53.8631,27.8187],[53.8631,27.7987]] },
    { fi:11, lat:53.869, lng:27.8287, border:[[53.8749,27.8187],[53.8749,27.8387],[53.8631,27.8387],[53.8631,27.8187]] },
    { fi:11, lat:53.869, lng:27.8487, border:[[53.8749,27.8387],[53.8749,27.8587],[53.8631,27.8587],[53.8631,27.8387]] },
    { fi:11, lat:53.868, lng:27.86538, border:[[53.8631,27.8587],[53.8749,27.8587],[53.8749,27.86718],[53.874,27.8653],[53.8631,27.87746]] },
    { fi:6, lat:53.88603, lng:27.0242, border:[[53.8867,27.03473],[53.8847,27.0187],[53.8867,27.01918]] },
    { fi:6, lat:53.88268, lng:27.07572, border:[[53.8867,27.0787],[53.8749,27.0787],[53.8749,27.0785],[53.8867,27.06976]] },
    { fi:6, lat:53.8808, lng:27.0887, border:[[53.8867,27.0787],[53.8867,27.0987],[53.8749,27.0987],[53.8749,27.0787]] },
    { fi:6, lat:53.8808, lng:27.1087, border:[[53.8867,27.0987],[53.8867,27.1187],[53.8749,27.1187],[53.8749,27.0987]] },
    { fi:6, lat:53.8808, lng:27.1287, border:[[53.8867,27.1187],[53.8867,27.1387],[53.8749,27.1387],[53.8749,27.1187]] },
    { fi:6, lat:53.8808, lng:27.1487, border:[[53.8867,27.1387],[53.8867,27.1587],[53.8749,27.1587],[53.8749,27.1387]] },
    { fi:6, lat:53.8808, lng:27.1687, border:[[53.8867,27.1587],[53.8867,27.1787],[53.8749,27.1787],[53.8749,27.1587]] },
    { fi:7, lat:53.8808, lng:27.1887, border:[[53.8867,27.1787],[53.8867,27.1987],[53.8749,27.1987],[53.8749,27.1787]] },
    { fi:7, lat:53.8808, lng:27.2087, border:[[53.8867,27.1987],[53.8867,27.2187],[53.8749,27.2187],[53.8749,27.1987]] },
    { fi:7, lat:53.8808, lng:27.2287, border:[[53.8867,27.2187],[53.8867,27.2387],[53.8749,27.2387],[53.8749,27.2187]] },
    { fi:7, lat:53.8808, lng:27.2487, border:[[53.8867,27.2387],[53.8867,27.2587],[53.8749,27.2587],[53.8749,27.2387]] },
    { fi:7, lat:53.8808, lng:27.2687, border:[[53.8867,27.2587],[53.8867,27.2787],[53.8749,27.2787],[53.8749,27.2587]] },
    { fi:7, lat:53.8808, lng:27.2887, border:[[53.8867,27.2787],[53.8867,27.2987],[53.8749,27.2987],[53.8749,27.2787]] },
    { fi:7, lat:53.8808, lng:27.3087, border:[[53.8867,27.2987],[53.8867,27.3187],[53.8749,27.3187],[53.8749,27.2987]] },
    { fi:7, lat:53.8808, lng:27.3287, border:[[53.8867,27.3187],[53.8867,27.3387],[53.8749,27.3387],[53.8749,27.3187]] },
    { fi:8, lat:53.8808, lng:27.3487, border:[[53.8867,27.3387],[53.8867,27.3587],[53.8749,27.3587],[53.8749,27.3387]] },
    { fi:8, lat:53.8808, lng:27.3687, border:[[53.8867,27.3587],[53.8867,27.3787],[53.8749,27.3787],[53.8749,27.3587]] },
    { fi:8, lat:53.8808, lng:27.3887, border:[[53.8867,27.3787],[53.8867,27.3987],[53.8749,27.3987],[53.8749,27.3787]] },
    { fi:8, lat:53.8808, lng:27.4087, border:[[53.8867,27.3987],[53.8867,27.4187],[53.8749,27.4187],[53.8749,27.3987]] },
    { fi:8, lat:53.8808, lng:27.4287, border:[[53.8867,27.4187],[53.8867,27.4387],[53.8749,27.4387],[53.8749,27.4187]] },
    { fi:8, lat:53.8808, lng:27.4487, border:[[53.8867,27.4387],[53.8867,27.4587],[53.8749,27.4587],[53.8749,27.4387]] },
    { fi:8, lat:53.8808, lng:27.4687, border:[[53.8867,27.4587],[53.8867,27.4787],[53.8749,27.4787],[53.8749,27.4587]] },
    { fi:8, lat:53.8808, lng:27.4887, border:[[53.8867,27.4787],[53.8867,27.4987],[53.8749,27.4987],[53.8749,27.4787]] },
    { fi:9, lat:53.8808, lng:27.5087, border:[[53.8867,27.4987],[53.8867,27.5187],[53.8749,27.5187],[53.8749,27.4987]] },
    { fi:9, lat:53.8808, lng:27.5287, border:[[53.8867,27.5187],[53.8867,27.5387],[53.8749,27.5387],[53.8749,27.5187]] },
    { fi:9, lat:53.8808, lng:27.5487, border:[[53.8867,27.5387],[53.8867,27.5587],[53.8749,27.5587],[53.8749,27.5387]] },
    { fi:9, lat:53.8808, lng:27.5687, border:[[53.8867,27.5587],[53.8867,27.5787],[53.8749,27.5787],[53.8749,27.5587]] },
    { fi:9, lat:53.8808, lng:27.5887, border:[[53.8867,27.5787],[53.8867,27.5987],[53.8749,27.5987],[53.8749,27.5787]] },
    { fi:9, lat:53.8808, lng:27.6087, border:[[53.8867,27.5987],[53.8867,27.6187],[53.8749,27.6187],[53.8749,27.5987]] },
    { fi:9, lat:53.8808, lng:27.6287, border:[[53.8867,27.6187],[53.8867,27.6387],[53.8749,27.6387],[53.8749,27.6187]] },
    { fi:9, lat:53.8808, lng:27.6487, border:[[53.8867,27.6387],[53.8867,27.6587],[53.8749,27.6587],[53.8749,27.6387]] },
    { fi:10, lat:53.8808, lng:27.6687, border:[[53.8867,27.6587],[53.8867,27.6787],[53.8749,27.6787],[53.8749,27.6587]] },
    { fi:10, lat:53.8808, lng:27.6887, border:[[53.8867,27.6787],[53.8867,27.6987],[53.8749,27.6987],[53.8749,27.6787]] },
    { fi:10, lat:53.8808, lng:27.7087, border:[[53.8867,27.6987],[53.8867,27.7187],[53.8749,27.7187],[53.8749,27.6987]] },
    { fi:10, lat:53.8808, lng:27.7287, border:[[53.8867,27.7187],[53.8867,27.7387],[53.8749,27.7387],[53.8749,27.7187]] },
    { fi:10, lat:53.8808, lng:27.7487, border:[[53.8867,27.7387],[53.8867,27.7587],[53.8749,27.7587],[53.8749,27.7387]] },
    { fi:10, lat:53.8808, lng:27.7687, border:[[53.8867,27.7587],[53.8867,27.7787],[53.8749,27.7787],[53.8749,27.7587]] },
    { fi:10, lat:53.8808, lng:27.7887, border:[[53.8867,27.7787],[53.8867,27.7987],[53.8749,27.7987],[53.8749,27.7787]] },
    { fi:10, lat:53.8808, lng:27.8087, border:[[53.8867,27.7987],[53.8867,27.8187],[53.8749,27.8187],[53.8749,27.7987]] },
    { fi:11, lat:53.8808, lng:27.8287, border:[[53.8867,27.8187],[53.8867,27.8387],[53.8749,27.8387],[53.8749,27.8187]] },
    { fi:11, lat:53.8808, lng:27.8487, border:[[53.8867,27.8387],[53.8867,27.8587],[53.8749,27.8587],[53.8749,27.8387]] },
    { fi:11, lat:53.88143, lng:27.86774, border:[[53.8749,27.8587],[53.8867,27.8587],[53.8867,27.8787],[53.88042,27.8787],[53.8749,27.86718]] },
    { fi:11, lat:53.88461, lng:27.88307, border:[[53.8867,27.8787],[53.8867,27.89181],[53.88042,27.8787]] },
    { fi:6, lat:53.89247, lng:27.02959, border:[[53.8867,27.01918],[53.8985,27.02199],[53.8985,27.0387],[53.88719,27.0387],[53.8867,27.03473]] },
    { fi:6, lat:53.89345, lng:27.04829, border:[[53.8985,27.0387],[53.8985,27.0587],[53.88969,27.0587],[53.88719,27.0387]] },
    { fi:6, lat:53.89331, lng:27.06953, border:[[53.8985,27.0587],[53.8985,27.0787],[53.8867,27.0787],[53.8867,27.06976],[53.8907,27.0668],[53.88969,27.0587]] },
    { fi:6, lat:53.8926, lng:27.0887, border:[[53.8985,27.0787],[53.8985,27.0987],[53.8867,27.0987],[53.8867,27.0787]] },
    { fi:6, lat:53.8926, lng:27.1087, border:[[53.8985,27.0987],[53.8985,27.1187],[53.8867,27.1187],[53.8867,27.0987]] },
    { fi:6, lat:53.8926, lng:27.1287, border:[[53.8985,27.1187],[53.8985,27.1387],[53.8867,27.1387],[53.8867,27.1187]] },
    { fi:6, lat:53.8926, lng:27.1487, border:[[53.8985,27.1387],[53.8985,27.1587],[53.8867,27.1587],[53.8867,27.1387]] },
    { fi:6, lat:53.8926, lng:27.1687, border:[[53.8985,27.1587],[53.8985,27.1787],[53.8867,27.1787],[53.8867,27.1587]] },
    { fi:7, lat:53.8926, lng:27.1887, border:[[53.8985,27.1787],[53.8985,27.1987],[53.8867,27.1987],[53.8867,27.1787]] },
    { fi:7, lat:53.8926, lng:27.2087, border:[[53.8985,27.1987],[53.8985,27.2187],[53.8867,27.2187],[53.8867,27.1987]] },
    { fi:7, lat:53.8926, lng:27.2287, border:[[53.8985,27.2187],[53.8985,27.2387],[53.8867,27.2387],[53.8867,27.2187]] },
    { fi:7, lat:53.8926, lng:27.2487, border:[[53.8985,27.2387],[53.8985,27.2587],[53.8867,27.2587],[53.8867,27.2387]] },
    { fi:7, lat:53.8926, lng:27.2687, border:[[53.8985,27.2587],[53.8985,27.2787],[53.8867,27.2787],[53.8867,27.2587]] },
    { fi:7, lat:53.8926, lng:27.2887, border:[[53.8985,27.2787],[53.8985,27.2987],[53.8867,27.2987],[53.8867,27.2787]] },
    { fi:7, lat:53.8926, lng:27.3087, border:[[53.8985,27.2987],[53.8985,27.3187],[53.8867,27.3187],[53.8867,27.2987]] },
    { fi:7, lat:53.8926, lng:27.3287, border:[[53.8985,27.3187],[53.8985,27.3387],[53.8867,27.3387],[53.8867,27.3187]] },
    { fi:8, lat:53.8926, lng:27.3487, border:[[53.8985,27.3387],[53.8985,27.3587],[53.8867,27.3587],[53.8867,27.3387]] },
    { fi:8, lat:53.8926, lng:27.3687, border:[[53.8985,27.3587],[53.8985,27.3787],[53.8867,27.3787],[53.8867,27.3587]] },
    { fi:8, lat:53.8926, lng:27.3887, border:[[53.8985,27.3787],[53.8985,27.3987],[53.8867,27.3987],[53.8867,27.3787]] },
    { fi:8, lat:53.8926, lng:27.4087, border:[[53.8985,27.3987],[53.8985,27.4187],[53.8867,27.4187],[53.8867,27.3987]] },
    { fi:8, lat:53.8926, lng:27.4287, border:[[53.8985,27.4187],[53.8985,27.4387],[53.8867,27.4387],[53.8867,27.4187]] },
    { fi:8, lat:53.8926, lng:27.4487, border:[[53.8985,27.4387],[53.8985,27.4587],[53.8867,27.4587],[53.8867,27.4387]] },
    { fi:8, lat:53.8926, lng:27.4687, border:[[53.8985,27.4587],[53.8985,27.4787],[53.8867,27.4787],[53.8867,27.4587]] },
    { fi:8, lat:53.8926, lng:27.4887, border:[[53.8985,27.4787],[53.8985,27.4987],[53.8867,27.4987],[53.8867,27.4787]] },
    { fi:9, lat:53.8926, lng:27.5087, border:[[53.8985,27.4987],[53.8985,27.5187],[53.8867,27.5187],[53.8867,27.4987]] },
    { fi:9, lat:53.8926, lng:27.5287, border:[[53.8985,27.5187],[53.8985,27.5387],[53.8867,27.5387],[53.8867,27.5187]] },
    { fi:9, lat:53.8926, lng:27.5487, border:[[53.8985,27.5387],[53.8985,27.5587],[53.8867,27.5587],[53.8867,27.5387]] },
    { fi:9, lat:53.8926, lng:27.5687, border:[[53.8985,27.5587],[53.8985,27.5787],[53.8867,27.5787],[53.8867,27.5587]] },
    { fi:9, lat:53.8926, lng:27.5887, border:[[53.8985,27.5787],[53.8985,27.5987],[53.8867,27.5987],[53.8867,27.5787]] },
    { fi:9, lat:53.8926, lng:27.6087, border:[[53.8985,27.5987],[53.8985,27.6187],[53.8867,27.6187],[53.8867,27.5987]] },
    { fi:9, lat:53.8926, lng:27.6287, border:[[53.8985,27.6187],[53.8985,27.6387],[53.8867,27.6387],[53.8867,27.6187]] },
    { fi:9, lat:53.8926, lng:27.6487, border:[[53.8985,27.6387],[53.8985,27.6587],[53.8867,27.6587],[53.8867,27.6387]] },
    { fi:10, lat:53.8926, lng:27.6687, border:[[53.8985,27.6587],[53.8985,27.6787],[53.8867,27.6787],[53.8867,27.6587]] },
    { fi:10, lat:53.8926, lng:27.6887, border:[[53.8985,27.6787],[53.8985,27.6987],[53.8867,27.6987],[53.8867,27.6787]] },
    { fi:10, lat:53.8926, lng:27.7087, border:[[53.8985,27.6987],[53.8985,27.7187],[53.8867,27.7187],[53.8867,27.6987]] },
    { fi:10, lat:53.8926, lng:27.7287, border:[[53.8985,27.7187],[53.8985,27.7387],[53.8867,27.7387],[53.8867,27.7187]] },
    { fi:10, lat:53.8926, lng:27.7487, border:[[53.8985,27.7387],[53.8985,27.7587],[53.8867,27.7587],[53.8867,27.7387]] },
    { fi:10, lat:53.8926, lng:27.7687, border:[[53.8985,27.7587],[53.8985,27.7787],[53.8867,27.7787],[53.8867,27.7587]] },
    { fi:10, lat:53.8926, lng:27.7887, border:[[53.8985,27.7787],[53.8985,27.7987],[53.8867,27.7987],[53.8867,27.7787]] },
    { fi:10, lat:53.8926, lng:27.8087, border:[[53.8985,27.7987],[53.8985,27.8187],[53.8867,27.8187],[53.8867,27.7987]] },
    { fi:11, lat:53.8926, lng:27.8287, border:[[53.8985,27.8187],[53.8985,27.8387],[53.8867,27.8387],[53.8867,27.8187]] },
    { fi:11, lat:53.8926, lng:27.8487, border:[[53.8985,27.8387],[53.8985,27.8587],[53.8867,27.8587],[53.8867,27.8387]] },
    { fi:11, lat:53.8926, lng:27.8687, border:[[53.8985,27.8587],[53.8985,27.8787],[53.8867,27.8787],[53.8867,27.8587]] },
    { fi:11, lat:53.89217, lng:27.88595, border:[[53.8867,27.8787],[53.8985,27.8787],[53.8985,27.8888],[53.8889,27.8964],[53.8867,27.89181]] },
    { fi:6, lat:53.90422, lng:27.03103, border:[[53.9103,27.0387],[53.8985,27.0387],[53.8985,27.02199],[53.9103,27.0248]] },
    { fi:6, lat:53.9044, lng:27.0487, border:[[53.9103,27.0387],[53.9103,27.0587],[53.8985,27.0587],[53.8985,27.0387]] },
    { fi:6, lat:53.9044, lng:27.0687, border:[[53.9103,27.0587],[53.9103,27.0787],[53.8985,27.0787],[53.8985,27.0587]] },
    { fi:6, lat:53.9044, lng:27.0887, border:[[53.9103,27.0787],[53.9103,27.0987],[53.8985,27.0987],[53.8985,27.0787]] },
    { fi:6, lat:53.9044, lng:27.1087, border:[[53.9103,27.0987],[53.9103,27.1187],[53.8985,27.1187],[53.8985,27.0987]] },
    { fi:6, lat:53.9044, lng:27.1287, border:[[53.9103,27.1187],[53.9103,27.1387],[53.8985,27.1387],[53.8985,27.1187]] },
    { fi:6, lat:53.9044, lng:27.1487, border:[[53.9103,27.1387],[53.9103,27.1587],[53.8985,27.1587],[53.8985,27.1387]] },
    { fi:6, lat:53.9044, lng:27.1687, border:[[53.9103,27.1587],[53.9103,27.1787],[53.8985,27.1787],[53.8985,27.1587]] },
    { fi:7, lat:53.9044, lng:27.1887, border:[[53.9103,27.1787],[53.9103,27.1987],[53.8985,27.1987],[53.8985,27.1787]] },
    { fi:7, lat:53.9044, lng:27.2087, border:[[53.9103,27.1987],[53.9103,27.2187],[53.8985,27.2187],[53.8985,27.1987]] },
    { fi:7, lat:53.9044, lng:27.2287, border:[[53.9103,27.2187],[53.9103,27.2387],[53.8985,27.2387],[53.8985,27.2187]] },
    { fi:7, lat:53.9044, lng:27.2487, border:[[53.9103,27.2387],[53.9103,27.2587],[53.8985,27.2587],[53.8985,27.2387]] },
    { fi:7, lat:53.9044, lng:27.2687, border:[[53.9103,27.2587],[53.9103,27.2787],[53.8985,27.2787],[53.8985,27.2587]] },
    { fi:7, lat:53.9044, lng:27.2887, border:[[53.9103,27.2787],[53.9103,27.2987],[53.8985,27.2987],[53.8985,27.2787]] },
    { fi:7, lat:53.9044, lng:27.3087, border:[[53.9103,27.2987],[53.9103,27.3187],[53.8985,27.3187],[53.8985,27.2987]] },
    { fi:7, lat:53.9044, lng:27.3287, border:[[53.9103,27.3187],[53.9103,27.3387],[53.8985,27.3387],[53.8985,27.3187]] },
    { fi:8, lat:53.9044, lng:27.3487, border:[[53.9103,27.3387],[53.9103,27.3587],[53.8985,27.3587],[53.8985,27.3387]] },
    { fi:8, lat:53.9044, lng:27.3687, border:[[53.9103,27.3587],[53.9103,27.3787],[53.8985,27.3787],[53.8985,27.3587]] },
    { fi:8, lat:53.9044, lng:27.3887, border:[[53.9103,27.3787],[53.9103,27.3987],[53.8985,27.3987],[53.8985,27.3787]] },
    { fi:8, lat:53.9044, lng:27.4087, border:[[53.9103,27.3987],[53.9103,27.4187],[53.8985,27.4187],[53.8985,27.3987]] },
    { fi:8, lat:53.9044, lng:27.4287, border:[[53.9103,27.4187],[53.9103,27.4387],[53.8985,27.4387],[53.8985,27.4187]] },
    { fi:8, lat:53.9044, lng:27.4487, border:[[53.9103,27.4387],[53.9103,27.4587],[53.8985,27.4587],[53.8985,27.4387]] },
    { fi:8, lat:53.9044, lng:27.4687, border:[[53.9103,27.4587],[53.9103,27.4787],[53.8985,27.4787],[53.8985,27.4587]] },
    { fi:8, lat:53.9044, lng:27.4887, border:[[53.9103,27.4787],[53.9103,27.4987],[53.8985,27.4987],[53.8985,27.4787]] },
    { fi:9, lat:53.9044, lng:27.5087, border:[[53.9103,27.4987],[53.9103,27.5187],[53.8985,27.5187],[53.8985,27.4987]] },
    { fi:9, lat:53.9044, lng:27.5287, border:[[53.9103,27.5187],[53.9103,27.5387],[53.8985,27.5387],[53.8985,27.5187]] },
    { fi:9, lat:53.9044, lng:27.5487, border:[[53.9103,27.5387],[53.9103,27.5587],[53.8985,27.5587],[53.8985,27.5387]] },
    { fi:9, lat:53.9044, lng:27.5687, border:[[53.9103,27.5587],[53.9103,27.5787],[53.8985,27.5787],[53.8985,27.5587]] },
    { fi:9, lat:53.9044, lng:27.5887, border:[[53.9103,27.5787],[53.9103,27.5987],[53.8985,27.5987],[53.8985,27.5787]] },
    { fi:9, lat:53.9044, lng:27.6087, border:[[53.9103,27.5987],[53.9103,27.6187],[53.8985,27.6187],[53.8985,27.5987]] },
    { fi:9, lat:53.9044, lng:27.6287, border:[[53.9103,27.6187],[53.9103,27.6387],[53.8985,27.6387],[53.8985,27.6187]] },
    { fi:9, lat:53.9044, lng:27.6487, border:[[53.9103,27.6387],[53.9103,27.6587],[53.8985,27.6587],[53.8985,27.6387]] },
    { fi:10, lat:53.9044, lng:27.6687, border:[[53.9103,27.6587],[53.9103,27.6787],[53.8985,27.6787],[53.8985,27.6587]] },
    { fi:10, lat:53.9044, lng:27.6887, border:[[53.9103,27.6787],[53.9103,27.6987],[53.8985,27.6987],[53.8985,27.6787]] },
    { fi:10, lat:53.9044, lng:27.7087, border:[[53.9103,27.6987],[53.9103,27.7187],[53.8985,27.7187],[53.8985,27.6987]] },
    { fi:10, lat:53.9044, lng:27.7287, border:[[53.9103,27.7187],[53.9103,27.7387],[53.8985,27.7387],[53.8985,27.7187]] },
    { fi:10, lat:53.9044, lng:27.7487, border:[[53.9103,27.7387],[53.9103,27.7587],[53.8985,27.7587],[53.8985,27.7387]] },
    { fi:10, lat:53.9044, lng:27.7687, border:[[53.9103,27.7587],[53.9103,27.7787],[53.8985,27.7787],[53.8985,27.7587]] },
    { fi:10, lat:53.9044, lng:27.7887, border:[[53.9103,27.7787],[53.9103,27.7987],[53.8985,27.7987],[53.8985,27.7787]] },
    { fi:10, lat:53.9044, lng:27.8087, border:[[53.9103,27.7987],[53.9103,27.8187],[53.8985,27.8187],[53.8985,27.7987]] },
    { fi:11, lat:53.9044, lng:27.8287, border:[[53.9103,27.8187],[53.9103,27.8387],[53.8985,27.8387],[53.8985,27.8187]] },
    { fi:11, lat:53.9044, lng:27.8487, border:[[53.9103,27.8387],[53.9103,27.8587],[53.8985,27.8587],[53.8985,27.8387]] },
    { fi:11, lat:53.9044, lng:27.8687, border:[[53.9103,27.8587],[53.9103,27.8787],[53.8985,27.8787],[53.8985,27.8587]] },
    { fi:11, lat:53.90562, lng:27.88682, border:[[53.8985,27.8787],[53.9103,27.8787],[53.9103,27.8987],[53.90526,27.8987],[53.9038,27.8846],[53.8985,27.8888]] },
    { fi:11, lat:53.90818, lng:27.90653, border:[[53.9103,27.8987],[53.9103,27.91545],[53.907,27.9156],[53.90526,27.8987]] },
    { fi:6, lat:53.91598, lng:27.03243, border:[[53.9221,27.0387],[53.9103,27.0387],[53.9103,27.0248],[53.9221,27.02761]] },
    { fi:6, lat:53.9162, lng:27.0487, border:[[53.9221,27.0387],[53.9221,27.0587],[53.9103,27.0587],[53.9103,27.0387]] },
    { fi:6, lat:53.9162, lng:27.0687, border:[[53.9221,27.0587],[53.9221,27.0787],[53.9103,27.0787],[53.9103,27.0587]] },
    { fi:6, lat:53.9162, lng:27.0887, border:[[53.9221,27.0787],[53.9221,27.0987],[53.9103,27.0987],[53.9103,27.0787]] },
    { fi:6, lat:53.9162, lng:27.1087, border:[[53.9221,27.0987],[53.9221,27.1187],[53.9103,27.1187],[53.9103,27.0987]] },
    { fi:6, lat:53.9162, lng:27.1287, border:[[53.9221,27.1187],[53.9221,27.1387],[53.9103,27.1387],[53.9103,27.1187]] },
    { fi:6, lat:53.9162, lng:27.1487, border:[[53.9221,27.1387],[53.9221,27.1587],[53.9103,27.1587],[53.9103,27.1387]] },
    { fi:6, lat:53.9162, lng:27.1687, border:[[53.9221,27.1587],[53.9221,27.1787],[53.9103,27.1787],[53.9103,27.1587]] },
    { fi:7, lat:53.9162, lng:27.1887, border:[[53.9221,27.1787],[53.9221,27.1987],[53.9103,27.1987],[53.9103,27.1787]] },
    { fi:7, lat:53.9162, lng:27.2087, border:[[53.9221,27.1987],[53.9221,27.2187],[53.9103,27.2187],[53.9103,27.1987]] },
    { fi:7, lat:53.9162, lng:27.2287, border:[[53.9221,27.2187],[53.9221,27.2387],[53.9103,27.2387],[53.9103,27.2187]] },
    { fi:7, lat:53.9162, lng:27.2487, border:[[53.9221,27.2387],[53.9221,27.2587],[53.9103,27.2587],[53.9103,27.2387]] },
    { fi:7, lat:53.9162, lng:27.2687, border:[[53.9221,27.2587],[53.9221,27.2787],[53.9103,27.2787],[53.9103,27.2587]] },
    { fi:7, lat:53.9162, lng:27.2887, border:[[53.9221,27.2787],[53.9221,27.2987],[53.9103,27.2987],[53.9103,27.2787]] },
    { fi:7, lat:53.9162, lng:27.3087, border:[[53.9221,27.2987],[53.9221,27.3187],[53.9103,27.3187],[53.9103,27.2987]] },
    { fi:7, lat:53.9162, lng:27.3287, border:[[53.9221,27.3187],[53.9221,27.3387],[53.9103,27.3387],[53.9103,27.3187]] },
    { fi:8, lat:53.9162, lng:27.3487, border:[[53.9221,27.3387],[53.9221,27.3587],[53.9103,27.3587],[53.9103,27.3387]] },
    { fi:8, lat:53.9162, lng:27.3687, border:[[53.9221,27.3587],[53.9221,27.3787],[53.9103,27.3787],[53.9103,27.3587]] },
    { fi:8, lat:53.9162, lng:27.3887, border:[[53.9221,27.3787],[53.9221,27.3987],[53.9103,27.3987],[53.9103,27.3787]] },
    { fi:8, lat:53.9162, lng:27.4087, border:[[53.9221,27.3987],[53.9221,27.4187],[53.9103,27.4187],[53.9103,27.3987]] },
    { fi:8, lat:53.9162, lng:27.4287, border:[[53.9221,27.4187],[53.9221,27.4387],[53.9103,27.4387],[53.9103,27.4187]] },
    { fi:8, lat:53.9162, lng:27.4487, border:[[53.9221,27.4387],[53.9221,27.4587],[53.9103,27.4587],[53.9103,27.4387]] },
    { fi:8, lat:53.9162, lng:27.4687, border:[[53.9221,27.4587],[53.9221,27.4787],[53.9103,27.4787],[53.9103,27.4587]] },
    { fi:8, lat:53.9162, lng:27.4887, border:[[53.9221,27.4787],[53.9221,27.4987],[53.9103,27.4987],[53.9103,27.4787]] },
    { fi:9, lat:53.9162, lng:27.5087, border:[[53.9221,27.4987],[53.9221,27.5187],[53.9103,27.5187],[53.9103,27.4987]] },
    { fi:9, lat:53.9162, lng:27.5287, border:[[53.9221,27.5187],[53.9221,27.5387],[53.9103,27.5387],[53.9103,27.5187]] },
    { fi:9, lat:53.9162, lng:27.5487, border:[[53.9221,27.5387],[53.9221,27.5587],[53.9103,27.5587],[53.9103,27.5387]] },
    { fi:9, lat:53.9162, lng:27.5687, border:[[53.9221,27.5587],[53.9221,27.5787],[53.9103,27.5787],[53.9103,27.5587]] },
    { fi:9, lat:53.9162, lng:27.5887, border:[[53.9221,27.5787],[53.9221,27.5987],[53.9103,27.5987],[53.9103,27.5787]] },
    { fi:9, lat:53.9162, lng:27.6087, border:[[53.9221,27.5987],[53.9221,27.6187],[53.9103,27.6187],[53.9103,27.5987]] },
    { fi:9, lat:53.9162, lng:27.6287, border:[[53.9221,27.6187],[53.9221,27.6387],[53.9103,27.6387],[53.9103,27.6187]] },
    { fi:9, lat:53.9162, lng:27.6487, border:[[53.9221,27.6387],[53.9221,27.6587],[53.9103,27.6587],[53.9103,27.6387]] },
    { fi:10, lat:53.9162, lng:27.6687, border:[[53.9221,27.6587],[53.9221,27.6787],[53.9103,27.6787],[53.9103,27.6587]] },
    { fi:10, lat:53.9162, lng:27.6887, border:[[53.9221,27.6787],[53.9221,27.6987],[53.9103,27.6987],[53.9103,27.6787]] },
    { fi:10, lat:53.9162, lng:27.7087, border:[[53.9221,27.6987],[53.9221,27.7187],[53.9103,27.7187],[53.9103,27.6987]] },
    { fi:10, lat:53.9162, lng:27.7287, border:[[53.9221,27.7187],[53.9221,27.7387],[53.9103,27.7387],[53.9103,27.7187]] },
    { fi:10, lat:53.9162, lng:27.7487, border:[[53.9221,27.7387],[53.9221,27.7587],[53.9103,27.7587],[53.9103,27.7387]] },
    { fi:10, lat:53.9162, lng:27.7687, border:[[53.9221,27.7587],[53.9221,27.7787],[53.9103,27.7787],[53.9103,27.7587]] },
    { fi:10, lat:53.9162, lng:27.7887, border:[[53.9221,27.7787],[53.9221,27.7987],[53.9103,27.7987],[53.9103,27.7787]] },
    { fi:10, lat:53.9162, lng:27.8087, border:[[53.9221,27.7987],[53.9221,27.8187],[53.9103,27.8187],[53.9103,27.7987]] },
    { fi:11, lat:53.9162, lng:27.8287, border:[[53.9221,27.8187],[53.9221,27.8387],[53.9103,27.8387],[53.9103,27.8187]] },
    { fi:11, lat:53.9162, lng:27.8487, border:[[53.9221,27.8387],[53.9221,27.8587],[53.9103,27.8587],[53.9103,27.8387]] },
    { fi:11, lat:53.9162, lng:27.8687, border:[[53.9221,27.8587],[53.9221,27.8787],[53.9103,27.8787],[53.9103,27.8587]] },
    { fi:11, lat:53.9162, lng:27.8887, border:[[53.9221,27.8787],[53.9221,27.8987],[53.9103,27.8987],[53.9103,27.8787]] },
    { fi:11, lat:53.91617, lng:27.90694, border:[[53.9103,27.8987],[53.9221,27.8987],[53.9221,27.9149],[53.9103,27.91545]] },
    { fi:6, lat:53.92771, lng:27.03383, border:[[53.9339,27.0387],[53.9221,27.0387],[53.9221,27.02761],[53.9339,27.03043]] },
    { fi:6, lat:53.928, lng:27.0487, border:[[53.9339,27.0387],[53.9339,27.0587],[53.9221,27.0587],[53.9221,27.0387]] },
    { fi:6, lat:53.928, lng:27.0687, border:[[53.9339,27.0587],[53.9339,27.0787],[53.9221,27.0787],[53.9221,27.0587]] },
    { fi:6, lat:53.928, lng:27.0887, border:[[53.9339,27.0787],[53.9339,27.0987],[53.9221,27.0987],[53.9221,27.0787]] },
    { fi:6, lat:53.928, lng:27.1087, border:[[53.9339,27.0987],[53.9339,27.1187],[53.9221,27.1187],[53.9221,27.0987]] },
    { fi:6, lat:53.928, lng:27.1287, border:[[53.9339,27.1187],[53.9339,27.1387],[53.9221,27.1387],[53.9221,27.1187]] },
    { fi:6, lat:53.928, lng:27.1487, border:[[53.9339,27.1387],[53.9339,27.1587],[53.9221,27.1587],[53.9221,27.1387]] },
    { fi:6, lat:53.928, lng:27.1687, border:[[53.9339,27.1587],[53.9339,27.1787],[53.9221,27.1787],[53.9221,27.1587]] },
    { fi:7, lat:53.928, lng:27.1887, border:[[53.9339,27.1787],[53.9339,27.1987],[53.9221,27.1987],[53.9221,27.1787]] },
    { fi:7, lat:53.928, lng:27.2087, border:[[53.9339,27.1987],[53.9339,27.2187],[53.9221,27.2187],[53.9221,27.1987]] },
    { fi:7, lat:53.928, lng:27.2287, border:[[53.9339,27.2187],[53.9339,27.2387],[53.9221,27.2387],[53.9221,27.2187]] },
    { fi:7, lat:53.928, lng:27.2487, border:[[53.9339,27.2387],[53.9339,27.2587],[53.9221,27.2587],[53.9221,27.2387]] },
    { fi:7, lat:53.928, lng:27.2687, border:[[53.9339,27.2587],[53.9339,27.2787],[53.9221,27.2787],[53.9221,27.2587]] },
    { fi:7, lat:53.928, lng:27.2887, border:[[53.9339,27.2787],[53.9339,27.2987],[53.9221,27.2987],[53.9221,27.2787]] },
    { fi:7, lat:53.928, lng:27.3087, border:[[53.9339,27.2987],[53.9339,27.3187],[53.9221,27.3187],[53.9221,27.2987]] },
    { fi:7, lat:53.928, lng:27.3287, border:[[53.9339,27.3187],[53.9339,27.3387],[53.9221,27.3387],[53.9221,27.3187]] },
    { fi:8, lat:53.928, lng:27.3487, border:[[53.9339,27.3387],[53.9339,27.3587],[53.9221,27.3587],[53.9221,27.3387]] },
    { fi:8, lat:53.928, lng:27.3687, border:[[53.9339,27.3587],[53.9339,27.3787],[53.9221,27.3787],[53.9221,27.3587]] },
    { fi:8, lat:53.928, lng:27.3887, border:[[53.9339,27.3787],[53.9339,27.3987],[53.9221,27.3987],[53.9221,27.3787]] },
    { fi:8, lat:53.928, lng:27.4087, border:[[53.9339,27.3987],[53.9339,27.4187],[53.9221,27.4187],[53.9221,27.3987]] },
    { fi:8, lat:53.928, lng:27.4287, border:[[53.9339,27.4187],[53.9339,27.4387],[53.9221,27.4387],[53.9221,27.4187]] },
    { fi:8, lat:53.928, lng:27.4487, border:[[53.9339,27.4387],[53.9339,27.4587],[53.9221,27.4587],[53.9221,27.4387]] },
    { fi:8, lat:53.928, lng:27.4687, border:[[53.9339,27.4587],[53.9339,27.4787],[53.9221,27.4787],[53.9221,27.4587]] },
    { fi:8, lat:53.928, lng:27.4887, border:[[53.9339,27.4787],[53.9339,27.4987],[53.9221,27.4987],[53.9221,27.4787]] },
    { fi:9, lat:53.928, lng:27.5087, border:[[53.9339,27.4987],[53.9339,27.5187],[53.9221,27.5187],[53.9221,27.4987]] },
    { fi:9, lat:53.928, lng:27.5287, border:[[53.9339,27.5187],[53.9339,27.5387],[53.9221,27.5387],[53.9221,27.5187]] },
    { fi:9, lat:53.928, lng:27.5487, border:[[53.9339,27.5387],[53.9339,27.5587],[53.9221,27.5587],[53.9221,27.5387]] },
    { fi:9, lat:53.928, lng:27.5687, border:[[53.9339,27.5587],[53.9339,27.5787],[53.9221,27.5787],[53.9221,27.5587]] },
    { fi:9, lat:53.928, lng:27.5887, border:[[53.9339,27.5787],[53.9339,27.5987],[53.9221,27.5987],[53.9221,27.5787]] },
    { fi:9, lat:53.928, lng:27.6087, border:[[53.9339,27.5987],[53.9339,27.6187],[53.9221,27.6187],[53.9221,27.5987]] },
    { fi:9, lat:53.928, lng:27.6287, border:[[53.9339,27.6187],[53.9339,27.6387],[53.9221,27.6387],[53.9221,27.6187]] },
    { fi:9, lat:53.928, lng:27.6487, border:[[53.9339,27.6387],[53.9339,27.6587],[53.9221,27.6587],[53.9221,27.6387]] },
    { fi:10, lat:53.928, lng:27.6687, border:[[53.9339,27.6587],[53.9339,27.6787],[53.9221,27.6787],[53.9221,27.6587]] },
    { fi:10, lat:53.928, lng:27.6887, border:[[53.9339,27.6787],[53.9339,27.6987],[53.9221,27.6987],[53.9221,27.6787]] },
    { fi:10, lat:53.928, lng:27.7087, border:[[53.9339,27.6987],[53.9339,27.7187],[53.9221,27.7187],[53.9221,27.6987]] },
    { fi:10, lat:53.928, lng:27.7287, border:[[53.9339,27.7187],[53.9339,27.7387],[53.9221,27.7387],[53.9221,27.7187]] },
    { fi:10, lat:53.928, lng:27.7487, border:[[53.9339,27.7387],[53.9339,27.7587],[53.9221,27.7587],[53.9221,27.7387]] },
    { fi:10, lat:53.928, lng:27.7687, border:[[53.9339,27.7587],[53.9339,27.7787],[53.9221,27.7787],[53.9221,27.7587]] },
    { fi:10, lat:53.928, lng:27.7887, border:[[53.9339,27.7787],[53.9339,27.7987],[53.9221,27.7987],[53.9221,27.7787]] },
    { fi:10, lat:53.928, lng:27.8087, border:[[53.9339,27.7987],[53.9339,27.8187],[53.9221,27.8187],[53.9221,27.7987]] },
    { fi:11, lat:53.928, lng:27.8287, border:[[53.9339,27.8187],[53.9339,27.8387],[53.9221,27.8387],[53.9221,27.8187]] },
    { fi:11, lat:53.928, lng:27.8487, border:[[53.9339,27.8387],[53.9339,27.8587],[53.9221,27.8587],[53.9221,27.8387]] },
    { fi:11, lat:53.928, lng:27.8687, border:[[53.9339,27.8587],[53.9339,27.8787],[53.9221,27.8787],[53.9221,27.8587]] },
    { fi:11, lat:53.928, lng:27.8887, border:[[53.9339,27.8787],[53.9339,27.8987],[53.9221,27.8987],[53.9221,27.8787]] },
    { fi:11, lat:53.92784, lng:27.90649, border:[[53.9221,27.8987],[53.9339,27.8987],[53.9339,27.91149],[53.9306,27.9145],[53.9221,27.9149]] },
    { fi:6, lat:53.9382, lng:27.03511, border:[[53.9339,27.0387],[53.9339,27.03043],[53.9426,27.0325],[53.94331,27.0387]] },
    { fi:6, lat:53.9392, lng:27.04906, border:[[53.9339,27.0587],[53.9339,27.0387],[53.94331,27.0387],[53.9456,27.0587]] },
    { fi:6, lat:53.9398, lng:27.0687, border:[[53.9457,27.0787],[53.9339,27.0787],[53.9339,27.0587],[53.9456,27.0587],[53.9457,27.05955]] },
    { fi:6, lat:53.9398, lng:27.0887, border:[[53.9457,27.0787],[53.9457,27.0987],[53.9339,27.0987],[53.9339,27.0787]] },
    { fi:6, lat:53.9398, lng:27.1087, border:[[53.9457,27.0987],[53.9457,27.1187],[53.9339,27.1187],[53.9339,27.0987]] },
    { fi:6, lat:53.9398, lng:27.1287, border:[[53.9457,27.1187],[53.9457,27.1387],[53.9339,27.1387],[53.9339,27.1187]] },
    { fi:6, lat:53.9398, lng:27.1487, border:[[53.9457,27.1387],[53.9457,27.1587],[53.9339,27.1587],[53.9339,27.1387]] },
    { fi:6, lat:53.9398, lng:27.1687, border:[[53.9457,27.1587],[53.9457,27.1787],[53.9339,27.1787],[53.9339,27.1587]] },
    { fi:7, lat:53.9398, lng:27.1887, border:[[53.9457,27.1787],[53.9457,27.1987],[53.9339,27.1987],[53.9339,27.1787]] },
    { fi:7, lat:53.9398, lng:27.2087, border:[[53.9457,27.1987],[53.9457,27.2187],[53.9339,27.2187],[53.9339,27.1987]] },
    { fi:7, lat:53.9398, lng:27.2287, border:[[53.9457,27.2187],[53.9457,27.2387],[53.9339,27.2387],[53.9339,27.2187]] },
    { fi:7, lat:53.9398, lng:27.2487, border:[[53.9457,27.2387],[53.9457,27.2587],[53.9339,27.2587],[53.9339,27.2387]] },
    { fi:7, lat:53.9398, lng:27.2687, border:[[53.9457,27.2587],[53.9457,27.2787],[53.9339,27.2787],[53.9339,27.2587]] },
    { fi:7, lat:53.9398, lng:27.2887, border:[[53.9457,27.2787],[53.9457,27.2987],[53.9339,27.2987],[53.9339,27.2787]] },
    { fi:7, lat:53.9398, lng:27.3087, border:[[53.9457,27.2987],[53.9457,27.3187],[53.9339,27.3187],[53.9339,27.2987]] },
    { fi:7, lat:53.9398, lng:27.3287, border:[[53.9457,27.3187],[53.9457,27.3387],[53.9339,27.3387],[53.9339,27.3187]] },
    { fi:8, lat:53.9398, lng:27.3487, border:[[53.9457,27.3387],[53.9457,27.3587],[53.9339,27.3587],[53.9339,27.3387]] },
    { fi:8, lat:53.9398, lng:27.3687, border:[[53.9457,27.3587],[53.9457,27.3787],[53.9339,27.3787],[53.9339,27.3587]] },
    { fi:8, lat:53.9398, lng:27.3887, border:[[53.9457,27.3787],[53.9457,27.3987],[53.9339,27.3987],[53.9339,27.3787]] },
    { fi:8, lat:53.9398, lng:27.4087, border:[[53.9457,27.3987],[53.9457,27.4187],[53.9339,27.4187],[53.9339,27.3987]] },
    { fi:8, lat:53.9398, lng:27.4287, border:[[53.9457,27.4187],[53.9457,27.4387],[53.9339,27.4387],[53.9339,27.4187]] },
    { fi:8, lat:53.9398, lng:27.4487, border:[[53.9457,27.4387],[53.9457,27.4587],[53.9339,27.4587],[53.9339,27.4387]] },
    { fi:8, lat:53.9398, lng:27.4687, border:[[53.9457,27.4587],[53.9457,27.4787],[53.9339,27.4787],[53.9339,27.4587]] },
    { fi:8, lat:53.9398, lng:27.4887, border:[[53.9457,27.4787],[53.9457,27.4987],[53.9339,27.4987],[53.9339,27.4787]] },
    { fi:9, lat:53.9398, lng:27.5087, border:[[53.9457,27.4987],[53.9457,27.5187],[53.9339,27.5187],[53.9339,27.4987]] },
    { fi:9, lat:53.9398, lng:27.5287, border:[[53.9457,27.5187],[53.9457,27.5387],[53.9339,27.5387],[53.9339,27.5187]] },
    { fi:9, lat:53.9398, lng:27.5487, border:[[53.9457,27.5387],[53.9457,27.5587],[53.9339,27.5587],[53.9339,27.5387]] },
    { fi:9, lat:53.9398, lng:27.5687, border:[[53.9457,27.5587],[53.9457,27.5787],[53.9339,27.5787],[53.9339,27.5587]] },
    { fi:9, lat:53.9398, lng:27.5887, border:[[53.9457,27.5787],[53.9457,27.5987],[53.9339,27.5987],[53.9339,27.5787]] },
    { fi:9, lat:53.9398, lng:27.6087, border:[[53.9457,27.5987],[53.9457,27.6187],[53.9339,27.6187],[53.9339,27.5987]] },
    { fi:9, lat:53.9398, lng:27.6287, border:[[53.9457,27.6187],[53.9457,27.6387],[53.9339,27.6387],[53.9339,27.6187]] },
    { fi:9, lat:53.9398, lng:27.6487, border:[[53.9457,27.6387],[53.9457,27.6587],[53.9339,27.6587],[53.9339,27.6387]] },
    { fi:10, lat:53.9398, lng:27.6687, border:[[53.9457,27.6587],[53.9457,27.6787],[53.9339,27.6787],[53.9339,27.6587]] },
    { fi:10, lat:53.9398, lng:27.6887, border:[[53.9457,27.6787],[53.9457,27.6987],[53.9339,27.6987],[53.9339,27.6787]] },
    { fi:10, lat:53.9398, lng:27.7087, border:[[53.9457,27.6987],[53.9457,27.7187],[53.9339,27.7187],[53.9339,27.6987]] },
    { fi:10, lat:53.9398, lng:27.7287, border:[[53.9457,27.7187],[53.9457,27.7387],[53.9339,27.7387],[53.9339,27.7187]] },
    { fi:10, lat:53.9398, lng:27.7487, border:[[53.9457,27.7387],[53.9457,27.7587],[53.9339,27.7587],[53.9339,27.7387]] },
    { fi:10, lat:53.9398, lng:27.7687, border:[[53.9457,27.7587],[53.9457,27.7787],[53.9339,27.7787],[53.9339,27.7587]] },
    { fi:10, lat:53.9398, lng:27.7887, border:[[53.9457,27.7787],[53.9457,27.7987],[53.9339,27.7987],[53.9339,27.7787]] },
    { fi:10, lat:53.9398, lng:27.8087, border:[[53.9457,27.7987],[53.9457,27.8187],[53.9339,27.8187],[53.9339,27.7987]] },
    { fi:11, lat:53.9398, lng:27.8287, border:[[53.9457,27.8187],[53.9457,27.8387],[53.9339,27.8387],[53.9339,27.8187]] },
    { fi:11, lat:53.9398, lng:27.8487, border:[[53.9457,27.8387],[53.9457,27.8587],[53.9339,27.8587],[53.9339,27.8387]] },
    { fi:11, lat:53.9398, lng:27.8687, border:[[53.9457,27.8587],[53.9457,27.8787],[53.9339,27.8787],[53.9339,27.8587]] },
    { fi:11, lat:53.9398, lng:27.8887, border:[[53.9457,27.8787],[53.9457,27.8987],[53.9339,27.8987],[53.9339,27.8787]] },
    { fi:11, lat:53.93838, lng:27.90306, border:[[53.9339,27.8987],[53.9457,27.8987],[53.9457,27.90075],[53.9339,27.91149]] },
    { fi:6, lat:53.94656, lng:27.0727, border:[[53.9457,27.0787],[53.9457,27.05955],[53.9477,27.077],[53.94962,27.0787]] },
    { fi:12, lat:53.95117, lng:27.08971, border:[[53.9575,27.0987],[53.9457,27.0987],[53.9457,27.0787],[53.94962,27.0787],[53.9575,27.08568]] },
    { fi:12, lat:53.9516, lng:27.1087, border:[[53.9575,27.0987],[53.9575,27.1187],[53.9457,27.1187],[53.9457,27.0987]] },
    { fi:12, lat:53.9516, lng:27.1287, border:[[53.9575,27.1187],[53.9575,27.1387],[53.9457,27.1387],[53.9457,27.1187]] },
    { fi:12, lat:53.9516, lng:27.1487, border:[[53.9575,27.1387],[53.9575,27.1587],[53.9457,27.1587],[53.9457,27.1387]] },
    { fi:12, lat:53.9516, lng:27.1687, border:[[53.9575,27.1587],[53.9575,27.1787],[53.9457,27.1787],[53.9457,27.1587]] },
    { fi:13, lat:53.9516, lng:27.1887, border:[[53.9575,27.1787],[53.9575,27.1987],[53.9457,27.1987],[53.9457,27.1787]] },
    { fi:13, lat:53.9516, lng:27.2087, border:[[53.9575,27.1987],[53.9575,27.2187],[53.9457,27.2187],[53.9457,27.1987]] },
    { fi:13, lat:53.9516, lng:27.2287, border:[[53.9575,27.2187],[53.9575,27.2387],[53.9457,27.2387],[53.9457,27.2187]] },
    { fi:13, lat:53.9516, lng:27.2487, border:[[53.9575,27.2387],[53.9575,27.2587],[53.9457,27.2587],[53.9457,27.2387]] },
    { fi:13, lat:53.9516, lng:27.2687, border:[[53.9575,27.2587],[53.9575,27.2787],[53.9457,27.2787],[53.9457,27.2587]] },
    { fi:13, lat:53.9516, lng:27.2887, border:[[53.9575,27.2787],[53.9575,27.2987],[53.9457,27.2987],[53.9457,27.2787]] },
    { fi:13, lat:53.9516, lng:27.3087, border:[[53.9575,27.2987],[53.9575,27.3187],[53.9457,27.3187],[53.9457,27.2987]] },
    { fi:13, lat:53.9516, lng:27.3287, border:[[53.9575,27.3187],[53.9575,27.3387],[53.9457,27.3387],[53.9457,27.3187]] },
    { fi:14, lat:53.9516, lng:27.3487, border:[[53.9575,27.3387],[53.9575,27.3587],[53.9457,27.3587],[53.9457,27.3387]] },
    { fi:14, lat:53.9516, lng:27.3687, border:[[53.9575,27.3587],[53.9575,27.3787],[53.9457,27.3787],[53.9457,27.3587]] },
    { fi:14, lat:53.9516, lng:27.3887, border:[[53.9575,27.3787],[53.9575,27.3987],[53.9457,27.3987],[53.9457,27.3787]] },
    { fi:14, lat:53.9516, lng:27.4087, border:[[53.9575,27.3987],[53.9575,27.4187],[53.9457,27.4187],[53.9457,27.3987]] },
    { fi:14, lat:53.9516, lng:27.4287, border:[[53.9575,27.4187],[53.9575,27.4387],[53.9457,27.4387],[53.9457,27.4187]] },
    { fi:14, lat:53.9516, lng:27.4487, border:[[53.9575,27.4387],[53.9575,27.4587],[53.9457,27.4587],[53.9457,27.4387]] },
    { fi:14, lat:53.9516, lng:27.4687, border:[[53.9575,27.4587],[53.9575,27.4787],[53.9457,27.4787],[53.9457,27.4587]] },
    { fi:14, lat:53.9516, lng:27.4887, border:[[53.9575,27.4787],[53.9575,27.4987],[53.9457,27.4987],[53.9457,27.4787]] },
    { fi:15, lat:53.9516, lng:27.5087, border:[[53.9575,27.4987],[53.9575,27.5187],[53.9457,27.5187],[53.9457,27.4987]] },
    { fi:15, lat:53.9516, lng:27.5287, border:[[53.9575,27.5187],[53.9575,27.5387],[53.9457,27.5387],[53.9457,27.5187]] },
    { fi:15, lat:53.9516, lng:27.5487, border:[[53.9575,27.5387],[53.9575,27.5587],[53.9457,27.5587],[53.9457,27.5387]] },
    { fi:15, lat:53.9516, lng:27.5687, border:[[53.9575,27.5587],[53.9575,27.5787],[53.9457,27.5787],[53.9457,27.5587]] },
    { fi:15, lat:53.9516, lng:27.5887, border:[[53.9575,27.5787],[53.9575,27.5987],[53.9457,27.5987],[53.9457,27.5787]] },
    { fi:15, lat:53.9516, lng:27.6087, border:[[53.9575,27.5987],[53.9575,27.6187],[53.9457,27.6187],[53.9457,27.5987]] },
    { fi:15, lat:53.9516, lng:27.6287, border:[[53.9575,27.6187],[53.9575,27.6387],[53.9457,27.6387],[53.9457,27.6187]] },
    { fi:15, lat:53.9516, lng:27.6487, border:[[53.9575,27.6387],[53.9575,27.6587],[53.9457,27.6587],[53.9457,27.6387]] },
    { fi:16, lat:53.9516, lng:27.6687, border:[[53.9575,27.6587],[53.9575,27.6787],[53.9457,27.6787],[53.9457,27.6587]] },
    { fi:16, lat:53.9516, lng:27.6887, border:[[53.9575,27.6787],[53.9575,27.6987],[53.9457,27.6987],[53.9457,27.6787]] },
    { fi:16, lat:53.9516, lng:27.7087, border:[[53.9575,27.6987],[53.9575,27.7187],[53.9457,27.7187],[53.9457,27.6987]] },
    { fi:16, lat:53.9516, lng:27.7287, border:[[53.9575,27.7187],[53.9575,27.7387],[53.9457,27.7387],[53.9457,27.7187]] },
    { fi:16, lat:53.9516, lng:27.7487, border:[[53.9575,27.7387],[53.9575,27.7587],[53.9457,27.7587],[53.9457,27.7387]] },
    { fi:16, lat:53.9516, lng:27.7687, border:[[53.9575,27.7587],[53.9575,27.7787],[53.9457,27.7787],[53.9457,27.7587]] },
    { fi:16, lat:53.9516, lng:27.7887, border:[[53.9575,27.7787],[53.9575,27.7987],[53.9457,27.7987],[53.9457,27.7787]] },
    { fi:16, lat:53.9516, lng:27.8087, border:[[53.9575,27.7987],[53.9575,27.8187],[53.9457,27.8187],[53.9457,27.7987]] },
    { fi:17, lat:53.9516, lng:27.8287, border:[[53.9575,27.8187],[53.9575,27.8387],[53.9457,27.8387],[53.9457,27.8187]] },
    { fi:17, lat:53.9516, lng:27.8487, border:[[53.9575,27.8387],[53.9575,27.8587],[53.9457,27.8587],[53.9457,27.8387]] },
    { fi:17, lat:53.9516, lng:27.8687, border:[[53.9575,27.8587],[53.9575,27.8787],[53.9457,27.8787],[53.9457,27.8587]] },
    { fi:17, lat:53.95102, lng:27.88718, border:[[53.9457,27.8987],[53.9457,27.8787],[53.9575,27.8787],[53.9575,27.89],[53.94795,27.8987]] },
    { fi:11, lat:53.94645, lng:27.89938, border:[[53.9457,27.8987],[53.94795,27.8987],[53.9457,27.90075]] },
    { fi:12, lat:53.96208, lng:27.09422, border:[[53.9693,27.0987],[53.9575,27.0987],[53.9575,27.08568],[53.9693,27.09613]] },
    { fi:12, lat:53.9634, lng:27.1087, border:[[53.9693,27.0987],[53.9693,27.1187],[53.9575,27.1187],[53.9575,27.0987]] },
    { fi:12, lat:53.9634, lng:27.1287, border:[[53.9693,27.1187],[53.9693,27.1387],[53.9575,27.1387],[53.9575,27.1187]] },
    { fi:12, lat:53.9634, lng:27.1487, border:[[53.9693,27.1387],[53.9693,27.1587],[53.9575,27.1587],[53.9575,27.1387]] },
    { fi:12, lat:53.9634, lng:27.1687, border:[[53.9693,27.1587],[53.9693,27.1787],[53.9575,27.1787],[53.9575,27.1587]] },
    { fi:13, lat:53.9634, lng:27.1887, border:[[53.9693,27.1787],[53.9693,27.1987],[53.9575,27.1987],[53.9575,27.1787]] },
    { fi:13, lat:53.9634, lng:27.2087, border:[[53.9693,27.1987],[53.9693,27.2187],[53.9575,27.2187],[53.9575,27.1987]] },
    { fi:13, lat:53.9634, lng:27.2287, border:[[53.9693,27.2187],[53.9693,27.2387],[53.9575,27.2387],[53.9575,27.2187]] },
    { fi:13, lat:53.9634, lng:27.2487, border:[[53.9693,27.2387],[53.9693,27.2587],[53.9575,27.2587],[53.9575,27.2387]] },
    { fi:13, lat:53.9634, lng:27.2687, border:[[53.9693,27.2587],[53.9693,27.2787],[53.9575,27.2787],[53.9575,27.2587]] },
    { fi:13, lat:53.9634, lng:27.2887, border:[[53.9693,27.2787],[53.9693,27.2987],[53.9575,27.2987],[53.9575,27.2787]] },
    { fi:13, lat:53.9634, lng:27.3087, border:[[53.9693,27.2987],[53.9693,27.3187],[53.9575,27.3187],[53.9575,27.2987]] },
    { fi:13, lat:53.9634, lng:27.3287, border:[[53.9693,27.3187],[53.9693,27.3387],[53.9575,27.3387],[53.9575,27.3187]] },
    { fi:14, lat:53.9634, lng:27.3487, border:[[53.9693,27.3387],[53.9693,27.3587],[53.9575,27.3587],[53.9575,27.3387]] },
    { fi:14, lat:53.9634, lng:27.3687, border:[[53.9693,27.3587],[53.9693,27.3787],[53.9575,27.3787],[53.9575,27.3587]] },
    { fi:14, lat:53.9634, lng:27.3887, border:[[53.9693,27.3787],[53.9693,27.3987],[53.9575,27.3987],[53.9575,27.3787]] },
    { fi:14, lat:53.9634, lng:27.4087, border:[[53.9693,27.3987],[53.9693,27.4187],[53.9575,27.4187],[53.9575,27.3987]] },
    { fi:14, lat:53.9634, lng:27.4287, border:[[53.9693,27.4187],[53.9693,27.4387],[53.9575,27.4387],[53.9575,27.4187]] },
    { fi:14, lat:53.9634, lng:27.4487, border:[[53.9693,27.4387],[53.9693,27.4587],[53.9575,27.4587],[53.9575,27.4387]] },
    { fi:14, lat:53.9634, lng:27.4687, border:[[53.9693,27.4587],[53.9693,27.4787],[53.9575,27.4787],[53.9575,27.4587]] },
    { fi:14, lat:53.9634, lng:27.4887, border:[[53.9693,27.4787],[53.9693,27.4987],[53.9575,27.4987],[53.9575,27.4787]] },
    { fi:15, lat:53.9634, lng:27.5087, border:[[53.9693,27.4987],[53.9693,27.5187],[53.9575,27.5187],[53.9575,27.4987]] },
    { fi:15, lat:53.9634, lng:27.5287, border:[[53.9693,27.5187],[53.9693,27.5387],[53.9575,27.5387],[53.9575,27.5187]] },
    { fi:15, lat:53.9634, lng:27.5487, border:[[53.9693,27.5387],[53.9693,27.5587],[53.9575,27.5587],[53.9575,27.5387]] },
    { fi:15, lat:53.9634, lng:27.5687, border:[[53.9693,27.5587],[53.9693,27.5787],[53.9575,27.5787],[53.9575,27.5587]] },
    { fi:15, lat:53.9634, lng:27.5887, border:[[53.9693,27.5787],[53.9693,27.5987],[53.9575,27.5987],[53.9575,27.5787]] },
    { fi:15, lat:53.9634, lng:27.6087, border:[[53.9693,27.5987],[53.9693,27.6187],[53.9575,27.6187],[53.9575,27.5987]] },
    { fi:15, lat:53.9634, lng:27.6287, border:[[53.9693,27.6187],[53.9693,27.6387],[53.9575,27.6387],[53.9575,27.6187]] },
    { fi:15, lat:53.9634, lng:27.6487, border:[[53.9693,27.6387],[53.9693,27.6587],[53.9575,27.6587],[53.9575,27.6387]] },
    { fi:16, lat:53.9634, lng:27.6687, border:[[53.9693,27.6587],[53.9693,27.6787],[53.9575,27.6787],[53.9575,27.6587]] },
    { fi:16, lat:53.9634, lng:27.6887, border:[[53.9693,27.6787],[53.9693,27.6987],[53.9575,27.6987],[53.9575,27.6787]] },
    { fi:16, lat:53.9634, lng:27.7087, border:[[53.9693,27.6987],[53.9693,27.7187],[53.9575,27.7187],[53.9575,27.6987]] },
    { fi:16, lat:53.9634, lng:27.7287, border:[[53.9693,27.7187],[53.9693,27.7387],[53.9575,27.7387],[53.9575,27.7187]] },
    { fi:16, lat:53.9634, lng:27.7487, border:[[53.9693,27.7387],[53.9693,27.7587],[53.9575,27.7587],[53.9575,27.7387]] },
    { fi:16, lat:53.9634, lng:27.7687, border:[[53.9693,27.7587],[53.9693,27.7787],[53.9575,27.7787],[53.9575,27.7587]] },
    { fi:16, lat:53.9634, lng:27.7887, border:[[53.9693,27.7787],[53.9693,27.7987],[53.9575,27.7987],[53.9575,27.7787]] },
    { fi:16, lat:53.9634, lng:27.8087, border:[[53.9693,27.7987],[53.9693,27.8187],[53.9575,27.8187],[53.9575,27.7987]] },
    { fi:17, lat:53.9634, lng:27.8287, border:[[53.9693,27.8187],[53.9693,27.8387],[53.9575,27.8387],[53.9575,27.8187]] },
    { fi:17, lat:53.9634, lng:27.8487, border:[[53.9693,27.8387],[53.9693,27.8587],[53.9575,27.8587],[53.9575,27.8387]] },
    { fi:17, lat:53.9634, lng:27.8687, border:[[53.9693,27.8587],[53.9693,27.8787],[53.9575,27.8787],[53.9575,27.8587]] },
    { fi:17, lat:53.96162, lng:27.88248, border:[[53.9575,27.8787],[53.9693,27.8787],[53.9693,27.87926],[53.9575,27.89]] },
    { fi:12, lat:53.97027, lng:27.09784, border:[[53.9693,27.0987],[53.9693,27.09613],[53.9722,27.0987]] },
    { fi:12, lat:53.97469, lng:27.10999, border:[[53.9811,27.1187],[53.9693,27.1187],[53.9693,27.0987],[53.9722,27.0987],[53.9811,27.10658]] },
    { fi:12, lat:53.9752, lng:27.1287, border:[[53.9811,27.1187],[53.9811,27.1387],[53.9693,27.1387],[53.9693,27.1187]] },
    { fi:12, lat:53.9752, lng:27.1487, border:[[53.9811,27.1387],[53.9811,27.1587],[53.9693,27.1587],[53.9693,27.1387]] },
    { fi:12, lat:53.9752, lng:27.1687, border:[[53.9811,27.1587],[53.9811,27.1787],[53.9693,27.1787],[53.9693,27.1587]] },
    { fi:13, lat:53.9752, lng:27.1887, border:[[53.9811,27.1787],[53.9811,27.1987],[53.9693,27.1987],[53.9693,27.1787]] },
    { fi:13, lat:53.9752, lng:27.2087, border:[[53.9811,27.1987],[53.9811,27.2187],[53.9693,27.2187],[53.9693,27.1987]] },
    { fi:13, lat:53.9752, lng:27.2287, border:[[53.9811,27.2187],[53.9811,27.2387],[53.9693,27.2387],[53.9693,27.2187]] },
    { fi:13, lat:53.9752, lng:27.2487, border:[[53.9811,27.2387],[53.9811,27.2587],[53.9693,27.2587],[53.9693,27.2387]] },
    { fi:13, lat:53.9752, lng:27.2687, border:[[53.9811,27.2587],[53.9811,27.2787],[53.9693,27.2787],[53.9693,27.2587]] },
    { fi:13, lat:53.9752, lng:27.2887, border:[[53.9811,27.2787],[53.9811,27.2987],[53.9693,27.2987],[53.9693,27.2787]] },
    { fi:13, lat:53.9752, lng:27.3087, border:[[53.9811,27.2987],[53.9811,27.3187],[53.9693,27.3187],[53.9693,27.2987]] },
    { fi:13, lat:53.9752, lng:27.3287, border:[[53.9811,27.3187],[53.9811,27.3387],[53.9693,27.3387],[53.9693,27.3187]] },
    { fi:14, lat:53.9752, lng:27.3487, border:[[53.9811,27.3387],[53.9811,27.3587],[53.9693,27.3587],[53.9693,27.3387]] },
    { fi:14, lat:53.9752, lng:27.3687, border:[[53.9811,27.3587],[53.9811,27.3787],[53.9693,27.3787],[53.9693,27.3587]] },
    { fi:14, lat:53.9752, lng:27.3887, border:[[53.9811,27.3787],[53.9811,27.3987],[53.9693,27.3987],[53.9693,27.3787]] },
    { fi:14, lat:53.9752, lng:27.4087, border:[[53.9811,27.3987],[53.9811,27.4187],[53.9693,27.4187],[53.9693,27.3987]] },
    { fi:14, lat:53.9752, lng:27.4287, border:[[53.9811,27.4187],[53.9811,27.4387],[53.9693,27.4387],[53.9693,27.4187]] },
    { fi:14, lat:53.9752, lng:27.4487, border:[[53.9811,27.4387],[53.9811,27.4587],[53.9693,27.4587],[53.9693,27.4387]] },
    { fi:14, lat:53.9752, lng:27.4687, border:[[53.9811,27.4587],[53.9811,27.4787],[53.9693,27.4787],[53.9693,27.4587]] },
    { fi:14, lat:53.9752, lng:27.4887, border:[[53.9811,27.4787],[53.9811,27.4987],[53.9693,27.4987],[53.9693,27.4787]] },
    { fi:15, lat:53.9752, lng:27.5087, border:[[53.9811,27.4987],[53.9811,27.5187],[53.9693,27.5187],[53.9693,27.4987]] },
    { fi:15, lat:53.9752, lng:27.5287, border:[[53.9811,27.5187],[53.9811,27.5387],[53.9693,27.5387],[53.9693,27.5187]] },
    { fi:15, lat:53.9752, lng:27.5487, border:[[53.9811,27.5387],[53.9811,27.5587],[53.9693,27.5587],[53.9693,27.5387]] },
    { fi:15, lat:53.9752, lng:27.5687, border:[[53.9811,27.5587],[53.9811,27.5787],[53.9693,27.5787],[53.9693,27.5587]] },
    { fi:15, lat:53.9752, lng:27.5887, border:[[53.9811,27.5787],[53.9811,27.5987],[53.9693,27.5987],[53.9693,27.5787]] },
    { fi:15, lat:53.9752, lng:27.6087, border:[[53.9811,27.5987],[53.9811,27.6187],[53.9693,27.6187],[53.9693,27.5987]] },
    { fi:15, lat:53.9752, lng:27.6287, border:[[53.9811,27.6187],[53.9811,27.6387],[53.9693,27.6387],[53.9693,27.6187]] },
    { fi:15, lat:53.9752, lng:27.6487, border:[[53.9811,27.6387],[53.9811,27.6587],[53.9693,27.6587],[53.9693,27.6387]] },
    { fi:16, lat:53.9752, lng:27.6687, border:[[53.9811,27.6587],[53.9811,27.6787],[53.9693,27.6787],[53.9693,27.6587]] },
    { fi:16, lat:53.9752, lng:27.6887, border:[[53.9811,27.6787],[53.9811,27.6987],[53.9693,27.6987],[53.9693,27.6787]] },
    { fi:16, lat:53.9752, lng:27.7087, border:[[53.9811,27.6987],[53.9811,27.7187],[53.9693,27.7187],[53.9693,27.6987]] },
    { fi:16, lat:53.9752, lng:27.7287, border:[[53.9811,27.7187],[53.9811,27.7387],[53.9693,27.7387],[53.9693,27.7187]] },
    { fi:16, lat:53.9752, lng:27.7487, border:[[53.9811,27.7387],[53.9811,27.7587],[53.9693,27.7587],[53.9693,27.7387]] },
    { fi:16, lat:53.9752, lng:27.7687, border:[[53.9811,27.7587],[53.9811,27.7787],[53.9693,27.7787],[53.9693,27.7587]] },
    { fi:16, lat:53.9752, lng:27.7887, border:[[53.9811,27.7787],[53.9811,27.7987],[53.9693,27.7987],[53.9693,27.7787]] },
    { fi:16, lat:53.9752, lng:27.8087, border:[[53.9811,27.7987],[53.9811,27.8187],[53.9693,27.8187],[53.9693,27.7987]] },
    { fi:17, lat:53.9752, lng:27.8287, border:[[53.9811,27.8187],[53.9811,27.8387],[53.9693,27.8387],[53.9693,27.8187]] },
    { fi:17, lat:53.9752, lng:27.8487, border:[[53.9811,27.8387],[53.9811,27.8587],[53.9693,27.8587],[53.9693,27.8387]] },
    { fi:17, lat:53.9752, lng:27.8687, border:[[53.9811,27.8587],[53.9811,27.8787],[53.9693,27.8787],[53.9693,27.8587]] },
    { fi:17, lat:53.97706, lng:27.87939, border:[[53.9693,27.8787],[53.9811,27.8787],[53.9811,27.88077],[53.9698,27.8788],[53.9693,27.87926]] },
    { fi:12, lat:53.98551, lng:27.11459, border:[[53.9929,27.1187],[53.9811,27.1187],[53.9811,27.10658],[53.9929,27.11703]] },
    { fi:12, lat:53.987, lng:27.1287, border:[[53.9929,27.1187],[53.9929,27.1387],[53.9811,27.1387],[53.9811,27.1187]] },
    { fi:12, lat:53.987, lng:27.1487, border:[[53.9929,27.1387],[53.9929,27.1587],[53.9811,27.1587],[53.9811,27.1387]] },
    { fi:12, lat:53.987, lng:27.1687, border:[[53.9929,27.1587],[53.9929,27.1787],[53.9811,27.1787],[53.9811,27.1587]] },
    { fi:13, lat:53.987, lng:27.1887, border:[[53.9929,27.1787],[53.9929,27.1987],[53.9811,27.1987],[53.9811,27.1787]] },
    { fi:13, lat:53.987, lng:27.2087, border:[[53.9929,27.1987],[53.9929,27.2187],[53.9811,27.2187],[53.9811,27.1987]] },
    { fi:13, lat:53.987, lng:27.2287, border:[[53.9929,27.2187],[53.9929,27.2387],[53.9811,27.2387],[53.9811,27.2187]] },
    { fi:13, lat:53.987, lng:27.2487, border:[[53.9929,27.2387],[53.9929,27.2587],[53.9811,27.2587],[53.9811,27.2387]] },
    { fi:13, lat:53.987, lng:27.2687, border:[[53.9929,27.2587],[53.9929,27.2787],[53.9811,27.2787],[53.9811,27.2587]] },
    { fi:13, lat:53.987, lng:27.2887, border:[[53.9929,27.2787],[53.9929,27.2987],[53.9811,27.2987],[53.9811,27.2787]] },
    { fi:13, lat:53.987, lng:27.3087, border:[[53.9929,27.2987],[53.9929,27.3187],[53.9811,27.3187],[53.9811,27.2987]] },
    { fi:13, lat:53.987, lng:27.3287, border:[[53.9929,27.3187],[53.9929,27.3387],[53.9811,27.3387],[53.9811,27.3187]] },
    { fi:14, lat:53.987, lng:27.3487, border:[[53.9929,27.3387],[53.9929,27.3587],[53.9811,27.3587],[53.9811,27.3387]] },
    { fi:14, lat:53.987, lng:27.3687, border:[[53.9929,27.3587],[53.9929,27.3787],[53.9811,27.3787],[53.9811,27.3587]] },
    { fi:14, lat:53.987, lng:27.3887, border:[[53.9929,27.3787],[53.9929,27.3987],[53.9811,27.3987],[53.9811,27.3787]] },
    { fi:14, lat:53.987, lng:27.4087, border:[[53.9929,27.3987],[53.9929,27.4187],[53.9811,27.4187],[53.9811,27.3987]] },
    { fi:14, lat:53.987, lng:27.4287, border:[[53.9929,27.4187],[53.9929,27.4387],[53.9811,27.4387],[53.9811,27.4187]] },
    { fi:14, lat:53.987, lng:27.4487, border:[[53.9929,27.4387],[53.9929,27.4587],[53.9811,27.4587],[53.9811,27.4387]] },
    { fi:14, lat:53.987, lng:27.4687, border:[[53.9929,27.4587],[53.9929,27.4787],[53.9811,27.4787],[53.9811,27.4587]] },
    { fi:14, lat:53.987, lng:27.4887, border:[[53.9929,27.4787],[53.9929,27.4987],[53.9811,27.4987],[53.9811,27.4787]] },
    { fi:15, lat:53.987, lng:27.5087, border:[[53.9929,27.4987],[53.9929,27.5187],[53.9811,27.5187],[53.9811,27.4987]] },
    { fi:15, lat:53.987, lng:27.5287, border:[[53.9929,27.5187],[53.9929,27.5387],[53.9811,27.5387],[53.9811,27.5187]] },
    { fi:15, lat:53.987, lng:27.5487, border:[[53.9929,27.5387],[53.9929,27.5587],[53.9811,27.5587],[53.9811,27.5387]] },
    { fi:15, lat:53.987, lng:27.5687, border:[[53.9929,27.5587],[53.9929,27.5787],[53.9811,27.5787],[53.9811,27.5587]] },
    { fi:15, lat:53.987, lng:27.5887, border:[[53.9929,27.5787],[53.9929,27.5987],[53.9811,27.5987],[53.9811,27.5787]] },
    { fi:15, lat:53.987, lng:27.6087, border:[[53.9929,27.5987],[53.9929,27.6187],[53.9811,27.6187],[53.9811,27.5987]] },
    { fi:15, lat:53.987, lng:27.6287, border:[[53.9929,27.6187],[53.9929,27.6387],[53.9811,27.6387],[53.9811,27.6187]] },
    { fi:15, lat:53.987, lng:27.6487, border:[[53.9929,27.6387],[53.9929,27.6587],[53.9811,27.6587],[53.9811,27.6387]] },
    { fi:16, lat:53.987, lng:27.6687, border:[[53.9929,27.6587],[53.9929,27.6787],[53.9811,27.6787],[53.9811,27.6587]] },
    { fi:16, lat:53.987, lng:27.6887, border:[[53.9929,27.6787],[53.9929,27.6987],[53.9811,27.6987],[53.9811,27.6787]] },
    { fi:16, lat:53.987, lng:27.7087, border:[[53.9929,27.6987],[53.9929,27.7187],[53.9811,27.7187],[53.9811,27.6987]] },
    { fi:16, lat:53.987, lng:27.7287, border:[[53.9929,27.7187],[53.9929,27.7387],[53.9811,27.7387],[53.9811,27.7187]] },
    { fi:16, lat:53.987, lng:27.7487, border:[[53.9929,27.7387],[53.9929,27.7587],[53.9811,27.7587],[53.9811,27.7387]] },
    { fi:16, lat:53.987, lng:27.7687, border:[[53.9929,27.7587],[53.9929,27.7787],[53.9811,27.7787],[53.9811,27.7587]] },
    { fi:16, lat:53.987, lng:27.7887, border:[[53.9929,27.7787],[53.9929,27.7987],[53.9811,27.7987],[53.9811,27.7787]] },
    { fi:16, lat:53.987, lng:27.8087, border:[[53.9929,27.7987],[53.9929,27.8187],[53.9811,27.8187],[53.9811,27.7987]] },
    { fi:17, lat:53.987, lng:27.8287, border:[[53.9929,27.8187],[53.9929,27.8387],[53.9811,27.8387],[53.9811,27.8187]] },
    { fi:17, lat:53.98685, lng:27.84841, border:[[53.9811,27.8587],[53.9811,27.8387],[53.9929,27.8387],[53.9929,27.8554],[53.9892,27.8579],[53.98931,27.8587]] },
    { fi:17, lat:53.98594, lng:27.86919, border:[[53.9811,27.8787],[53.9811,27.8587],[53.98931,27.8587],[53.99212,27.8787]] },
    { fi:17, lat:53.98736, lng:27.88031, border:[[53.9811,27.8787],[53.99212,27.8787],[53.9927,27.8828],[53.9811,27.88077]] },
    { fi:12, lat:53.99353, lng:27.11814, border:[[53.9929,27.1187],[53.9929,27.11703],[53.99478,27.1187]] },
    { fi:12, lat:53.99821, lng:27.1303, border:[[54.0047,27.1387],[53.9929,27.1387],[53.9929,27.1187],[53.99478,27.1187],[54.0047,27.12748]] },
    { fi:12, lat:53.9988, lng:27.1487, border:[[54.0047,27.1387],[54.0047,27.1587],[53.9929,27.1587],[53.9929,27.1387]] },
    { fi:12, lat:53.99878, lng:27.16866, border:[[53.9929,27.1787],[53.9929,27.1587],[54.0047,27.1587],[54.0047,27.17469],[54.00422,27.1787]] },
    { fi:13, lat:53.99869, lng:27.18884, border:[[54.0047,27.1987],[53.9929,27.1987],[53.9929,27.1787],[54.00422,27.1787],[54.0036,27.1839],[54.0047,27.18495]] },
    { fi:13, lat:53.9988, lng:27.2087, border:[[54.0047,27.1987],[54.0047,27.2187],[53.9929,27.2187],[53.9929,27.1987]] },
    { fi:13, lat:53.9988, lng:27.2287, border:[[54.0047,27.2187],[54.0047,27.2387],[53.9929,27.2387],[53.9929,27.2187]] },
    { fi:13, lat:53.9988, lng:27.2487, border:[[54.0047,27.2387],[54.0047,27.2587],[53.9929,27.2587],[53.9929,27.2387]] },
    { fi:13, lat:53.9988, lng:27.2687, border:[[54.0047,27.2587],[54.0047,27.2787],[53.9929,27.2787],[53.9929,27.2587]] },
    { fi:13, lat:53.9988, lng:27.2887, border:[[54.0047,27.2787],[54.0047,27.2987],[53.9929,27.2987],[53.9929,27.2787]] },
    { fi:13, lat:53.9988, lng:27.3087, border:[[54.0047,27.2987],[54.0047,27.3187],[53.9929,27.3187],[53.9929,27.2987]] },
    { fi:13, lat:53.9988, lng:27.3287, border:[[54.0047,27.3187],[54.0047,27.3387],[53.9929,27.3387],[53.9929,27.3187]] },
    { fi:14, lat:53.9988, lng:27.3487, border:[[54.0047,27.3387],[54.0047,27.3587],[53.9929,27.3587],[53.9929,27.3387]] },
    { fi:14, lat:53.9988, lng:27.3687, border:[[54.0047,27.3587],[54.0047,27.3787],[53.9929,27.3787],[53.9929,27.3587]] },
    { fi:14, lat:53.9988, lng:27.3887, border:[[54.0047,27.3787],[54.0047,27.3987],[53.9929,27.3987],[53.9929,27.3787]] },
    { fi:14, lat:53.9988, lng:27.4087, border:[[54.0047,27.3987],[54.0047,27.4187],[53.9929,27.4187],[53.9929,27.3987]] },
    { fi:14, lat:53.9988, lng:27.4287, border:[[54.0047,27.4187],[54.0047,27.4387],[53.9929,27.4387],[53.9929,27.4187]] },
    { fi:14, lat:53.9988, lng:27.4487, border:[[54.0047,27.4387],[54.0047,27.4587],[53.9929,27.4587],[53.9929,27.4387]] },
    { fi:14, lat:53.9988, lng:27.4687, border:[[54.0047,27.4587],[54.0047,27.4787],[53.9929,27.4787],[53.9929,27.4587]] },
    { fi:14, lat:53.9988, lng:27.4887, border:[[54.0047,27.4787],[54.0047,27.4987],[53.9929,27.4987],[53.9929,27.4787]] },
    { fi:15, lat:53.9988, lng:27.5087, border:[[54.0047,27.4987],[54.0047,27.5187],[53.9929,27.5187],[53.9929,27.4987]] },
    { fi:15, lat:53.9988, lng:27.5287, border:[[54.0047,27.5187],[54.0047,27.5387],[53.9929,27.5387],[53.9929,27.5187]] },
    { fi:15, lat:53.9988, lng:27.5487, border:[[54.0047,27.5387],[54.0047,27.5587],[53.9929,27.5587],[53.9929,27.5387]] },
    { fi:15, lat:53.9988, lng:27.5687, border:[[54.0047,27.5587],[54.0047,27.5787],[53.9929,27.5787],[53.9929,27.5587]] },
    { fi:15, lat:53.9988, lng:27.5887, border:[[54.0047,27.5787],[54.0047,27.5987],[53.9929,27.5987],[53.9929,27.5787]] },
    { fi:15, lat:53.9988, lng:27.6087, border:[[54.0047,27.5987],[54.0047,27.6187],[53.9929,27.6187],[53.9929,27.5987]] },
    { fi:15, lat:53.9988, lng:27.6287, border:[[54.0047,27.6187],[54.0047,27.6387],[53.9929,27.6387],[53.9929,27.6187]] },
    { fi:15, lat:53.9988, lng:27.6487, border:[[54.0047,27.6387],[54.0047,27.6587],[53.9929,27.6587],[53.9929,27.6387]] },
    { fi:16, lat:53.9988, lng:27.6687, border:[[54.0047,27.6587],[54.0047,27.6787],[53.9929,27.6787],[53.9929,27.6587]] },
    { fi:16, lat:53.9988, lng:27.6887, border:[[54.0047,27.6787],[54.0047,27.6987],[53.9929,27.6987],[53.9929,27.6787]] },
    { fi:16, lat:53.9988, lng:27.7087, border:[[54.0047,27.6987],[54.0047,27.7187],[53.9929,27.7187],[53.9929,27.6987]] },
    { fi:16, lat:53.9988, lng:27.7287, border:[[54.0047,27.7187],[54.0047,27.7387],[53.9929,27.7387],[53.9929,27.7187]] },
    { fi:16, lat:53.9988, lng:27.7487, border:[[54.0047,27.7387],[54.0047,27.7587],[53.9929,27.7587],[53.9929,27.7387]] },
    { fi:16, lat:53.9988, lng:27.7687, border:[[54.0047,27.7587],[54.0047,27.7787],[53.9929,27.7787],[53.9929,27.7587]] },
    { fi:16, lat:53.9988, lng:27.7887, border:[[54.0047,27.7787],[54.0047,27.7987],[53.9929,27.7987],[53.9929,27.7787]] },
    { fi:16, lat:53.9988, lng:27.8087, border:[[54.0047,27.7987],[54.0047,27.8187],[53.9929,27.8187],[53.9929,27.7987]] },
    { fi:17, lat:53.9988, lng:27.8287, border:[[54.0047,27.8187],[54.0047,27.8387],[53.9929,27.8387],[53.9929,27.8187]] },
    { fi:17, lat:53.99818, lng:27.84526, border:[[53.9929,27.8387],[54.0047,27.8387],[54.0047,27.84741],[53.9929,27.8554]] },
    { fi:12, lat:54.00688, lng:27.13398, border:[[54.0047,27.1387],[54.0047,27.12748],[54.0098,27.132],[54.009,27.1387]] },
    { fi:12, lat:54.00633, lng:27.14742, border:[[54.0047,27.1587],[54.0047,27.1387],[54.009,27.1387],[54.00661,27.1587]] },
    { fi:12, lat:54.00534, lng:27.16403, border:[[54.0047,27.1587],[54.00661,27.1587],[54.0047,27.17469]] },
    { fi:13, lat:54.00925, lng:27.19398, border:[[54.0165,27.1987],[54.0047,27.1987],[54.0047,27.18495],[54.0165,27.19616]] },
    { fi:13, lat:54.0106, lng:27.2087, border:[[54.0165,27.1987],[54.0165,27.2187],[54.0047,27.2187],[54.0047,27.1987]] },
    { fi:13, lat:54.0106, lng:27.2287, border:[[54.0165,27.2187],[54.0165,27.2387],[54.0047,27.2387],[54.0047,27.2187]] },
    { fi:13, lat:54.0106, lng:27.2487, border:[[54.0165,27.2387],[54.0165,27.2587],[54.0047,27.2587],[54.0047,27.2387]] },
    { fi:13, lat:54.0106, lng:27.2687, border:[[54.0165,27.2587],[54.0165,27.2787],[54.0047,27.2787],[54.0047,27.2587]] },
    { fi:13, lat:54.0106, lng:27.2887, border:[[54.0165,27.2787],[54.0165,27.2987],[54.0047,27.2987],[54.0047,27.2787]] },
    { fi:13, lat:54.0106, lng:27.3087, border:[[54.0165,27.2987],[54.0165,27.3187],[54.0047,27.3187],[54.0047,27.2987]] },
    { fi:13, lat:54.0106, lng:27.3287, border:[[54.0165,27.3187],[54.0165,27.3387],[54.0047,27.3387],[54.0047,27.3187]] },
    { fi:14, lat:54.0106, lng:27.3487, border:[[54.0165,27.3387],[54.0165,27.3587],[54.0047,27.3587],[54.0047,27.3387]] },
    { fi:14, lat:54.0106, lng:27.3687, border:[[54.0165,27.3587],[54.0165,27.3787],[54.0047,27.3787],[54.0047,27.3587]] },
    { fi:14, lat:54.0106, lng:27.3887, border:[[54.0165,27.3787],[54.0165,27.3987],[54.0047,27.3987],[54.0047,27.3787]] },
    { fi:14, lat:54.0106, lng:27.4087, border:[[54.0165,27.3987],[54.0165,27.4187],[54.0047,27.4187],[54.0047,27.3987]] },
    { fi:14, lat:54.0106, lng:27.4287, border:[[54.0165,27.4187],[54.0165,27.4387],[54.0047,27.4387],[54.0047,27.4187]] },
    { fi:14, lat:54.0106, lng:27.4487, border:[[54.0165,27.4387],[54.0165,27.4587],[54.0047,27.4587],[54.0047,27.4387]] },
    { fi:14, lat:54.0106, lng:27.4687, border:[[54.0165,27.4587],[54.0165,27.4787],[54.0047,27.4787],[54.0047,27.4587]] },
    { fi:14, lat:54.0106, lng:27.4887, border:[[54.0165,27.4787],[54.0165,27.4987],[54.0047,27.4987],[54.0047,27.4787]] },
    { fi:15, lat:54.0106, lng:27.5087, border:[[54.0165,27.4987],[54.0165,27.5187],[54.0047,27.5187],[54.0047,27.4987]] },
    { fi:15, lat:54.0106, lng:27.5287, border:[[54.0165,27.5187],[54.0165,27.5387],[54.0047,27.5387],[54.0047,27.5187]] },
    { fi:15, lat:54.0106, lng:27.5487, border:[[54.0165,27.5387],[54.0165,27.5587],[54.0047,27.5587],[54.0047,27.5387]] },
    { fi:15, lat:54.0106, lng:27.5687, border:[[54.0165,27.5587],[54.0165,27.5787],[54.0047,27.5787],[54.0047,27.5587]] },
    { fi:15, lat:54.0106, lng:27.5887, border:[[54.0165,27.5787],[54.0165,27.5987],[54.0047,27.5987],[54.0047,27.5787]] },
    { fi:15, lat:54.0106, lng:27.6087, border:[[54.0165,27.5987],[54.0165,27.6187],[54.0047,27.6187],[54.0047,27.5987]] },
    { fi:15, lat:54.0106, lng:27.6287, border:[[54.0165,27.6187],[54.0165,27.6387],[54.0047,27.6387],[54.0047,27.6187]] },
    { fi:15, lat:54.0106, lng:27.6487, border:[[54.0165,27.6387],[54.0165,27.6587],[54.0047,27.6587],[54.0047,27.6387]] },
    { fi:16, lat:54.0106, lng:27.6687, border:[[54.0165,27.6587],[54.0165,27.6787],[54.0047,27.6787],[54.0047,27.6587]] },
    { fi:16, lat:54.0106, lng:27.6887, border:[[54.0165,27.6787],[54.0165,27.6987],[54.0047,27.6987],[54.0047,27.6787]] },
    { fi:16, lat:54.0106, lng:27.7087, border:[[54.0165,27.6987],[54.0165,27.7187],[54.0047,27.7187],[54.0047,27.6987]] },
    { fi:16, lat:54.0106, lng:27.7287, border:[[54.0165,27.7187],[54.0165,27.7387],[54.0047,27.7387],[54.0047,27.7187]] },
    { fi:16, lat:54.0106, lng:27.7487, border:[[54.0165,27.7387],[54.0165,27.7587],[54.0047,27.7587],[54.0047,27.7387]] },
    { fi:16, lat:54.0106, lng:27.7687, border:[[54.0165,27.7587],[54.0165,27.7787],[54.0047,27.7787],[54.0047,27.7587]] },
    { fi:16, lat:54.0106, lng:27.7887, border:[[54.0165,27.7787],[54.0165,27.7987],[54.0047,27.7987],[54.0047,27.7787]] },
    { fi:16, lat:54.0106, lng:27.8087, border:[[54.0165,27.7987],[54.0165,27.8187],[54.0047,27.8187],[54.0047,27.7987]] },
    { fi:17, lat:54.0106, lng:27.8287, border:[[54.0165,27.8187],[54.0165,27.8387],[54.0047,27.8387],[54.0047,27.8187]] },
    { fi:17, lat:54.00894, lng:27.84162, border:[[54.0047,27.8387],[54.0165,27.8387],[54.0165,27.83957],[54.0164,27.8395],[54.0047,27.84741]] },
    { fi:13, lat:54.01739, lng:27.19785, border:[[54.0165,27.1987],[54.0165,27.19616],[54.01918,27.1987]] },
    { fi:13, lat:54.02583, lng:27.19792, border:[[54.0283,27.1987],[54.02088,27.1987],[54.0283,27.19637]] },
    { fi:13, lat:54.0224, lng:27.20871, border:[[54.0283,27.1987],[54.0283,27.2187],[54.0165,27.2187],[54.0165,27.1987],[54.01918,27.1987],[54.0196,27.1991],[54.02088,27.1987]] },
    { fi:13, lat:54.0224, lng:27.2287, border:[[54.0283,27.2187],[54.0283,27.2387],[54.0165,27.2387],[54.0165,27.2187]] },
    { fi:13, lat:54.0224, lng:27.2487, border:[[54.0283,27.2387],[54.0283,27.2587],[54.0165,27.2587],[54.0165,27.2387]] },
    { fi:13, lat:54.0224, lng:27.2687, border:[[54.0283,27.2587],[54.0283,27.2787],[54.0165,27.2787],[54.0165,27.2587]] },
    { fi:13, lat:54.0224, lng:27.2887, border:[[54.0283,27.2787],[54.0283,27.2987],[54.0165,27.2987],[54.0165,27.2787]] },
    { fi:13, lat:54.0224, lng:27.3087, border:[[54.0283,27.2987],[54.0283,27.3187],[54.0165,27.3187],[54.0165,27.2987]] },
    { fi:13, lat:54.0224, lng:27.3287, border:[[54.0283,27.3187],[54.0283,27.3387],[54.0165,27.3387],[54.0165,27.3187]] },
    { fi:14, lat:54.0224, lng:27.3487, border:[[54.0283,27.3387],[54.0283,27.3587],[54.0165,27.3587],[54.0165,27.3387]] },
    { fi:14, lat:54.0224, lng:27.3687, border:[[54.0283,27.3587],[54.0283,27.3787],[54.0165,27.3787],[54.0165,27.3587]] },
    { fi:14, lat:54.0224, lng:27.3887, border:[[54.0283,27.3787],[54.0283,27.3987],[54.0165,27.3987],[54.0165,27.3787]] },
    { fi:14, lat:54.0224, lng:27.4087, border:[[54.0283,27.3987],[54.0283,27.4187],[54.0165,27.4187],[54.0165,27.3987]] },
    { fi:14, lat:54.0224, lng:27.4287, border:[[54.0283,27.4187],[54.0283,27.4387],[54.0165,27.4387],[54.0165,27.4187]] },
    { fi:14, lat:54.0224, lng:27.4487, border:[[54.0283,27.4387],[54.0283,27.4587],[54.0165,27.4587],[54.0165,27.4387]] },
    { fi:14, lat:54.0224, lng:27.4687, border:[[54.0283,27.4587],[54.0283,27.4787],[54.0165,27.4787],[54.0165,27.4587]] },
    { fi:14, lat:54.0224, lng:27.4887, border:[[54.0283,27.4787],[54.0283,27.4987],[54.0165,27.4987],[54.0165,27.4787]] },
    { fi:15, lat:54.0224, lng:27.5087, border:[[54.0283,27.4987],[54.0283,27.5187],[54.0165,27.5187],[54.0165,27.4987]] },
    { fi:15, lat:54.0224, lng:27.5287, border:[[54.0283,27.5187],[54.0283,27.5387],[54.0165,27.5387],[54.0165,27.5187]] },
    { fi:15, lat:54.0224, lng:27.5487, border:[[54.0283,27.5387],[54.0283,27.5587],[54.0165,27.5587],[54.0165,27.5387]] },
    { fi:15, lat:54.0224, lng:27.5687, border:[[54.0283,27.5587],[54.0283,27.5787],[54.0165,27.5787],[54.0165,27.5587]] },
    { fi:15, lat:54.0224, lng:27.5887, border:[[54.0283,27.5787],[54.0283,27.5987],[54.0165,27.5987],[54.0165,27.5787]] },
    { fi:15, lat:54.0224, lng:27.6087, border:[[54.0283,27.5987],[54.0283,27.6187],[54.0165,27.6187],[54.0165,27.5987]] },
    { fi:15, lat:54.0224, lng:27.6287, border:[[54.0283,27.6187],[54.0283,27.6387],[54.0165,27.6387],[54.0165,27.6187]] },
    { fi:15, lat:54.0224, lng:27.6487, border:[[54.0283,27.6387],[54.0283,27.6587],[54.0165,27.6587],[54.0165,27.6387]] },
    { fi:16, lat:54.0224, lng:27.6687, border:[[54.0283,27.6587],[54.0283,27.6787],[54.0165,27.6787],[54.0165,27.6587]] },
    { fi:16, lat:54.0224, lng:27.6887, border:[[54.0283,27.6787],[54.0283,27.6987],[54.0165,27.6987],[54.0165,27.6787]] },
    { fi:16, lat:54.0224, lng:27.7087, border:[[54.0283,27.6987],[54.0283,27.7187],[54.0165,27.7187],[54.0165,27.6987]] },
    { fi:16, lat:54.0224, lng:27.7287, border:[[54.0283,27.7187],[54.0283,27.7387],[54.0165,27.7387],[54.0165,27.7187]] },
    { fi:16, lat:54.0224, lng:27.7487, border:[[54.0283,27.7387],[54.0283,27.7587],[54.0165,27.7587],[54.0165,27.7387]] },
    { fi:16, lat:54.0224, lng:27.7687, border:[[54.0283,27.7587],[54.0283,27.7787],[54.0165,27.7787],[54.0165,27.7587]] },
    { fi:16, lat:54.0224, lng:27.7887, border:[[54.0283,27.7787],[54.0283,27.7987],[54.0165,27.7987],[54.0165,27.7787]] },
    { fi:16, lat:54.0224, lng:27.8087, border:[[54.0283,27.7987],[54.0283,27.8187],[54.0165,27.8187],[54.0165,27.7987]] },
    { fi:17, lat:54.0224, lng:27.8287, border:[[54.0283,27.8187],[54.0283,27.8387],[54.0165,27.8387],[54.0165,27.8187]] },
    { fi:17, lat:54.02403, lng:27.84183, border:[[54.0165,27.8387],[54.0283,27.8387],[54.0283,27.84803],[54.0165,27.83957]] },
    { fi:13, lat:54.03507, lng:27.19648, border:[[54.0401,27.1987],[54.0283,27.1987],[54.0283,27.19637],[54.0401,27.19268]] },
    { fi:13, lat:54.0342, lng:27.2087, border:[[54.0401,27.1987],[54.0401,27.2187],[54.0283,27.2187],[54.0283,27.1987]] },
    { fi:13, lat:54.0342, lng:27.2287, border:[[54.0401,27.2187],[54.0401,27.2387],[54.0283,27.2387],[54.0283,27.2187]] },
    { fi:13, lat:54.0342, lng:27.2487, border:[[54.0401,27.2387],[54.0401,27.2587],[54.0283,27.2587],[54.0283,27.2387]] },
    { fi:13, lat:54.0342, lng:27.2687, border:[[54.0401,27.2587],[54.0401,27.2787],[54.0283,27.2787],[54.0283,27.2587]] },
    { fi:13, lat:54.0342, lng:27.2887, border:[[54.0401,27.2787],[54.0401,27.2987],[54.0283,27.2987],[54.0283,27.2787]] },
    { fi:13, lat:54.0342, lng:27.3087, border:[[54.0401,27.2987],[54.0401,27.3187],[54.0283,27.3187],[54.0283,27.2987]] },
    { fi:13, lat:54.0342, lng:27.3287, border:[[54.0401,27.3187],[54.0401,27.3387],[54.0283,27.3387],[54.0283,27.3187]] },
    { fi:14, lat:54.0342, lng:27.3487, border:[[54.0401,27.3387],[54.0401,27.3587],[54.0283,27.3587],[54.0283,27.3387]] },
    { fi:14, lat:54.0342, lng:27.3687, border:[[54.0401,27.3587],[54.0401,27.3787],[54.0283,27.3787],[54.0283,27.3587]] },
    { fi:14, lat:54.0342, lng:27.3887, border:[[54.0401,27.3787],[54.0401,27.3987],[54.0283,27.3987],[54.0283,27.3787]] },
    { fi:14, lat:54.0342, lng:27.4087, border:[[54.0401,27.3987],[54.0401,27.4187],[54.0283,27.4187],[54.0283,27.3987]] },
    { fi:14, lat:54.0342, lng:27.4287, border:[[54.0401,27.4187],[54.0401,27.4387],[54.0283,27.4387],[54.0283,27.4187]] },
    { fi:14, lat:54.0342, lng:27.4487, border:[[54.0401,27.4387],[54.0401,27.4587],[54.0283,27.4587],[54.0283,27.4387]] },
    { fi:14, lat:54.0342, lng:27.4687, border:[[54.0401,27.4587],[54.0401,27.4787],[54.0283,27.4787],[54.0283,27.4587]] },
    { fi:14, lat:54.0342, lng:27.4887, border:[[54.0401,27.4787],[54.0401,27.4987],[54.0283,27.4987],[54.0283,27.4787]] },
    { fi:15, lat:54.0342, lng:27.5087, border:[[54.0401,27.4987],[54.0401,27.5187],[54.0283,27.5187],[54.0283,27.4987]] },
    { fi:15, lat:54.0342, lng:27.5287, border:[[54.0401,27.5187],[54.0401,27.5387],[54.0283,27.5387],[54.0283,27.5187]] },
    { fi:15, lat:54.0342, lng:27.5487, border:[[54.0401,27.5387],[54.0401,27.5587],[54.0283,27.5587],[54.0283,27.5387]] },
    { fi:15, lat:54.0342, lng:27.5687, border:[[54.0401,27.5587],[54.0401,27.5787],[54.0283,27.5787],[54.0283,27.5587]] },
    { fi:15, lat:54.0342, lng:27.5887, border:[[54.0401,27.5787],[54.0401,27.5987],[54.0283,27.5987],[54.0283,27.5787]] },
    { fi:15, lat:54.0342, lng:27.6087, border:[[54.0401,27.5987],[54.0401,27.6187],[54.0283,27.6187],[54.0283,27.5987]] },
    { fi:15, lat:54.0342, lng:27.6287, border:[[54.0401,27.6187],[54.0401,27.6387],[54.0283,27.6387],[54.0283,27.6187]] },
    { fi:15, lat:54.0342, lng:27.6487, border:[[54.0401,27.6387],[54.0401,27.6587],[54.0283,27.6587],[54.0283,27.6387]] },
    { fi:16, lat:54.0342, lng:27.6687, border:[[54.0401,27.6587],[54.0401,27.6787],[54.0283,27.6787],[54.0283,27.6587]] },
    { fi:16, lat:54.0342, lng:27.6887, border:[[54.0401,27.6787],[54.0401,27.6987],[54.0283,27.6987],[54.0283,27.6787]] },
    { fi:16, lat:54.0342, lng:27.7087, border:[[54.0401,27.6987],[54.0401,27.7187],[54.0283,27.7187],[54.0283,27.6987]] },
    { fi:16, lat:54.0342, lng:27.7287, border:[[54.0401,27.7187],[54.0401,27.7387],[54.0283,27.7387],[54.0283,27.7187]] },
    { fi:16, lat:54.0342, lng:27.7487, border:[[54.0401,27.7387],[54.0401,27.7587],[54.0283,27.7587],[54.0283,27.7387]] },
    { fi:16, lat:54.0342, lng:27.7687, border:[[54.0401,27.7587],[54.0401,27.7787],[54.0283,27.7787],[54.0283,27.7587]] },
    { fi:16, lat:54.0342, lng:27.7887, border:[[54.0401,27.7787],[54.0401,27.7987],[54.0283,27.7987],[54.0283,27.7787]] },
    { fi:16, lat:54.03415, lng:27.80863, border:[[54.0283,27.8187],[54.0283,27.7987],[54.0401,27.7987],[54.0401,27.81508],[54.039,27.8187]] },
    { fi:17, lat:54.03234, lng:27.82739, border:[[54.0283,27.8387],[54.0283,27.8187],[54.039,27.8187],[54.03295,27.8387]] },
    { fi:17, lat:54.03, lng:27.84286, border:[[54.0283,27.8387],[54.03295,27.8387],[54.0298,27.8491],[54.0283,27.84803]] },
    { fi:12, lat:54.04801, lng:27.17317, border:[[54.0519,27.1787],[54.0434,27.1787],[54.0453,27.1664],[54.0519,27.16802]] },
    { fi:13, lat:54.04671, lng:27.18933, border:[[54.0519,27.1787],[54.0519,27.1987],[54.0401,27.1987],[54.0401,27.19268],[54.0413,27.1923],[54.0434,27.1787]] },
    { fi:13, lat:54.046, lng:27.2087, border:[[54.0519,27.1987],[54.0519,27.2187],[54.0401,27.2187],[54.0401,27.1987]] },
    { fi:13, lat:54.046, lng:27.2287, border:[[54.0519,27.2187],[54.0519,27.2387],[54.0401,27.2387],[54.0401,27.2187]] },
    { fi:13, lat:54.046, lng:27.2487, border:[[54.0519,27.2387],[54.0519,27.2587],[54.0401,27.2587],[54.0401,27.2387]] },
    { fi:13, lat:54.046, lng:27.2687, border:[[54.0519,27.2587],[54.0519,27.2787],[54.0401,27.2787],[54.0401,27.2587]] },
    { fi:13, lat:54.046, lng:27.2887, border:[[54.0519,27.2787],[54.0519,27.2987],[54.0401,27.2987],[54.0401,27.2787]] },
    { fi:13, lat:54.046, lng:27.3087, border:[[54.0519,27.2987],[54.0519,27.3187],[54.0401,27.3187],[54.0401,27.2987]] },
    { fi:13, lat:54.046, lng:27.3287, border:[[54.0519,27.3187],[54.0519,27.3387],[54.0401,27.3387],[54.0401,27.3187]] },
    { fi:14, lat:54.046, lng:27.3487, border:[[54.0519,27.3387],[54.0519,27.3587],[54.0401,27.3587],[54.0401,27.3387]] },
    { fi:14, lat:54.046, lng:27.3687, border:[[54.0519,27.3587],[54.0519,27.3787],[54.0401,27.3787],[54.0401,27.3587]] },
    { fi:14, lat:54.046, lng:27.3887, border:[[54.0519,27.3787],[54.0519,27.3987],[54.0401,27.3987],[54.0401,27.3787]] },
    { fi:14, lat:54.046, lng:27.4087, border:[[54.0519,27.3987],[54.0519,27.4187],[54.0401,27.4187],[54.0401,27.3987]] },
    { fi:14, lat:54.046, lng:27.4287, border:[[54.0519,27.4187],[54.0519,27.4387],[54.0401,27.4387],[54.0401,27.4187]] },
    { fi:14, lat:54.046, lng:27.4487, border:[[54.0519,27.4387],[54.0519,27.4587],[54.0401,27.4587],[54.0401,27.4387]] },
    { fi:14, lat:54.046, lng:27.4687, border:[[54.0519,27.4587],[54.0519,27.4787],[54.0401,27.4787],[54.0401,27.4587]] },
    { fi:14, lat:54.046, lng:27.4887, border:[[54.0519,27.4787],[54.0519,27.4987],[54.0401,27.4987],[54.0401,27.4787]] },
    { fi:15, lat:54.046, lng:27.5087, border:[[54.0519,27.4987],[54.0519,27.5187],[54.0401,27.5187],[54.0401,27.4987]] },
    { fi:15, lat:54.046, lng:27.5287, border:[[54.0519,27.5187],[54.0519,27.5387],[54.0401,27.5387],[54.0401,27.5187]] },
    { fi:15, lat:54.046, lng:27.5487, border:[[54.0519,27.5387],[54.0519,27.5587],[54.0401,27.5587],[54.0401,27.5387]] },
    { fi:15, lat:54.046, lng:27.5687, border:[[54.0519,27.5587],[54.0519,27.5787],[54.0401,27.5787],[54.0401,27.5587]] },
    { fi:15, lat:54.046, lng:27.5887, border:[[54.0519,27.5787],[54.0519,27.5987],[54.0401,27.5987],[54.0401,27.5787]] },
    { fi:15, lat:54.046, lng:27.6087, border:[[54.0519,27.5987],[54.0519,27.6187],[54.0401,27.6187],[54.0401,27.5987]] },
    { fi:15, lat:54.046, lng:27.6287, border:[[54.0519,27.6187],[54.0519,27.6387],[54.0401,27.6387],[54.0401,27.6187]] },
    { fi:15, lat:54.046, lng:27.6487, border:[[54.0519,27.6387],[54.0519,27.6587],[54.0401,27.6587],[54.0401,27.6387]] },
    { fi:16, lat:54.046, lng:27.6687, border:[[54.0519,27.6587],[54.0519,27.6787],[54.0401,27.6787],[54.0401,27.6587]] },
    { fi:16, lat:54.046, lng:27.6887, border:[[54.0519,27.6787],[54.0519,27.6987],[54.0401,27.6987],[54.0401,27.6787]] },
    { fi:16, lat:54.046, lng:27.7087, border:[[54.0519,27.6987],[54.0519,27.7187],[54.0401,27.7187],[54.0401,27.6987]] },
    { fi:16, lat:54.046, lng:27.7287, border:[[54.0519,27.7187],[54.0519,27.7387],[54.0401,27.7387],[54.0401,27.7187]] },
    { fi:16, lat:54.046, lng:27.7487, border:[[54.0519,27.7387],[54.0519,27.7587],[54.0401,27.7587],[54.0401,27.7387]] },
    { fi:16, lat:54.046, lng:27.7687, border:[[54.0519,27.7587],[54.0519,27.7787],[54.0401,27.7787],[54.0401,27.7587]] },
    { fi:16, lat:54.04573, lng:27.78785, border:[[54.0401,27.7987],[54.0401,27.7787],[54.0519,27.7787],[54.0519,27.79583],[54.0463,27.7946],[54.04506,27.7987]] },
    { fi:16, lat:54.04175, lng:27.80416, border:[[54.0401,27.7987],[54.04506,27.7987],[54.0401,27.81508]] },
    { fi:12, lat:54.05749, lng:27.17405, border:[[54.0637,27.1787],[54.0519,27.1787],[54.0519,27.16802],[54.0637,27.17091]] },
    { fi:13, lat:54.0578, lng:27.1887, border:[[54.0637,27.1787],[54.0637,27.1987],[54.0519,27.1987],[54.0519,27.1787]] },
    { fi:13, lat:54.0578, lng:27.2087, border:[[54.0637,27.1987],[54.0637,27.2187],[54.0519,27.2187],[54.0519,27.1987]] },
    { fi:13, lat:54.0578, lng:27.2287, border:[[54.0637,27.2187],[54.0637,27.2387],[54.0519,27.2387],[54.0519,27.2187]] },
    { fi:13, lat:54.0578, lng:27.2487, border:[[54.0637,27.2387],[54.0637,27.2587],[54.0519,27.2587],[54.0519,27.2387]] },
    { fi:13, lat:54.0578, lng:27.2687, border:[[54.0637,27.2587],[54.0637,27.2787],[54.0519,27.2787],[54.0519,27.2587]] },
    { fi:13, lat:54.0578, lng:27.2887, border:[[54.0637,27.2787],[54.0637,27.2987],[54.0519,27.2987],[54.0519,27.2787]] },
    { fi:13, lat:54.0578, lng:27.3087, border:[[54.0637,27.2987],[54.0637,27.3187],[54.0519,27.3187],[54.0519,27.2987]] },
    { fi:13, lat:54.0578, lng:27.3287, border:[[54.0637,27.3187],[54.0637,27.3387],[54.0519,27.3387],[54.0519,27.3187]] },
    { fi:14, lat:54.0578, lng:27.3487, border:[[54.0637,27.3387],[54.0637,27.3587],[54.0519,27.3587],[54.0519,27.3387]] },
    { fi:14, lat:54.0578, lng:27.3687, border:[[54.0637,27.3587],[54.0637,27.3787],[54.0519,27.3787],[54.0519,27.3587]] },
    { fi:14, lat:54.0578, lng:27.3887, border:[[54.0637,27.3787],[54.0637,27.3987],[54.0519,27.3987],[54.0519,27.3787]] },
    { fi:14, lat:54.0578, lng:27.4087, border:[[54.0637,27.3987],[54.0637,27.4187],[54.0519,27.4187],[54.0519,27.3987]] },
    { fi:14, lat:54.0578, lng:27.4287, border:[[54.0637,27.4187],[54.0637,27.4387],[54.0519,27.4387],[54.0519,27.4187]] },
    { fi:14, lat:54.0578, lng:27.4487, border:[[54.0637,27.4387],[54.0637,27.4587],[54.0519,27.4587],[54.0519,27.4387]] },
    { fi:14, lat:54.0578, lng:27.4687, border:[[54.0637,27.4587],[54.0637,27.4787],[54.0519,27.4787],[54.0519,27.4587]] },
    { fi:14, lat:54.0578, lng:27.4887, border:[[54.0637,27.4787],[54.0637,27.4987],[54.0519,27.4987],[54.0519,27.4787]] },
    { fi:15, lat:54.0578, lng:27.5087, border:[[54.0637,27.4987],[54.0637,27.5187],[54.0519,27.5187],[54.0519,27.4987]] },
    { fi:15, lat:54.0578, lng:27.5287, border:[[54.0637,27.5187],[54.0637,27.5387],[54.0519,27.5387],[54.0519,27.5187]] },
    { fi:15, lat:54.0578, lng:27.5487, border:[[54.0637,27.5387],[54.0637,27.5587],[54.0519,27.5587],[54.0519,27.5387]] },
    { fi:15, lat:54.0578, lng:27.5687, border:[[54.0637,27.5587],[54.0637,27.5787],[54.0519,27.5787],[54.0519,27.5587]] },
    { fi:15, lat:54.0578, lng:27.5887, border:[[54.0637,27.5787],[54.0637,27.5987],[54.0519,27.5987],[54.0519,27.5787]] },
    { fi:15, lat:54.0578, lng:27.6087, border:[[54.0637,27.5987],[54.0637,27.6187],[54.0519,27.6187],[54.0519,27.5987]] },
    { fi:15, lat:54.0578, lng:27.6287, border:[[54.0637,27.6187],[54.0637,27.6387],[54.0519,27.6387],[54.0519,27.6187]] },
    { fi:15, lat:54.0578, lng:27.6487, border:[[54.0637,27.6387],[54.0637,27.6587],[54.0519,27.6587],[54.0519,27.6387]] },
    { fi:16, lat:54.0578, lng:27.6687, border:[[54.0637,27.6587],[54.0637,27.6787],[54.0519,27.6787],[54.0519,27.6587]] },
    { fi:16, lat:54.0578, lng:27.6887, border:[[54.0637,27.6787],[54.0637,27.6987],[54.0519,27.6987],[54.0519,27.6787]] },
    { fi:16, lat:54.0578, lng:27.7087, border:[[54.0637,27.6987],[54.0637,27.7187],[54.0519,27.7187],[54.0519,27.6987]] },
    { fi:16, lat:54.0578, lng:27.7287, border:[[54.0637,27.7187],[54.0637,27.7387],[54.0519,27.7387],[54.0519,27.7187]] },
    { fi:16, lat:54.0578, lng:27.7487, border:[[54.0637,27.7387],[54.0637,27.7587],[54.0519,27.7587],[54.0519,27.7387]] },
    { fi:16, lat:54.0578, lng:27.7687, border:[[54.0637,27.7587],[54.0637,27.7787],[54.0519,27.7787],[54.0519,27.7587]] },
    { fi:16, lat:54.05794, lng:27.78793, border:[[54.0519,27.7787],[54.0637,27.7787],[54.0637,27.79841],[54.0519,27.79583]] },
    { fi:12, lat:54.06529, lng:27.17502, border:[[54.0637,27.1787],[54.0637,27.17091],[54.0669,27.1717],[54.06698,27.1787]] },
    { fi:13, lat:54.06959, lng:27.19012, border:[[54.0755,27.1787],[54.0755,27.1987],[54.0637,27.1987],[54.0637,27.1787],[54.06698,27.1787],[54.0671,27.1898],[54.07481,27.1787]] },
    { fi:13, lat:54.0696, lng:27.2087, border:[[54.0755,27.1987],[54.0755,27.2187],[54.0637,27.2187],[54.0637,27.1987]] },
    { fi:13, lat:54.0696, lng:27.2287, border:[[54.0755,27.2187],[54.0755,27.2387],[54.0637,27.2387],[54.0637,27.2187]] },
    { fi:13, lat:54.0696, lng:27.2487, border:[[54.0755,27.2387],[54.0755,27.2587],[54.0637,27.2587],[54.0637,27.2387]] },
    { fi:13, lat:54.0696, lng:27.2687, border:[[54.0755,27.2587],[54.0755,27.2787],[54.0637,27.2787],[54.0637,27.2587]] },
    { fi:13, lat:54.0696, lng:27.2887, border:[[54.0755,27.2787],[54.0755,27.2987],[54.0637,27.2987],[54.0637,27.2787]] },
    { fi:13, lat:54.0696, lng:27.3087, border:[[54.0755,27.2987],[54.0755,27.3187],[54.0637,27.3187],[54.0637,27.2987]] },
    { fi:13, lat:54.0696, lng:27.3287, border:[[54.0755,27.3187],[54.0755,27.3387],[54.0637,27.3387],[54.0637,27.3187]] },
    { fi:14, lat:54.0696, lng:27.3487, border:[[54.0755,27.3387],[54.0755,27.3587],[54.0637,27.3587],[54.0637,27.3387]] },
    { fi:14, lat:54.0696, lng:27.3687, border:[[54.0755,27.3587],[54.0755,27.3787],[54.0637,27.3787],[54.0637,27.3587]] },
    { fi:14, lat:54.0696, lng:27.3887, border:[[54.0755,27.3787],[54.0755,27.3987],[54.0637,27.3987],[54.0637,27.3787]] },
    { fi:14, lat:54.0696, lng:27.4087, border:[[54.0755,27.3987],[54.0755,27.4187],[54.0637,27.4187],[54.0637,27.3987]] },
    { fi:14, lat:54.0696, lng:27.4287, border:[[54.0755,27.4187],[54.0755,27.4387],[54.0637,27.4387],[54.0637,27.4187]] },
    { fi:14, lat:54.0696, lng:27.4487, border:[[54.0755,27.4387],[54.0755,27.4587],[54.0637,27.4587],[54.0637,27.4387]] },
    { fi:14, lat:54.0696, lng:27.4687, border:[[54.0755,27.4587],[54.0755,27.4787],[54.0637,27.4787],[54.0637,27.4587]] },
    { fi:14, lat:54.0696, lng:27.4887, border:[[54.0755,27.4787],[54.0755,27.4987],[54.0637,27.4987],[54.0637,27.4787]] },
    { fi:15, lat:54.0696, lng:27.5087, border:[[54.0755,27.4987],[54.0755,27.5187],[54.0637,27.5187],[54.0637,27.4987]] },
    { fi:15, lat:54.0696, lng:27.5287, border:[[54.0755,27.5187],[54.0755,27.5387],[54.0637,27.5387],[54.0637,27.5187]] },
    { fi:15, lat:54.0696, lng:27.5487, border:[[54.0755,27.5387],[54.0755,27.5587],[54.0637,27.5587],[54.0637,27.5387]] },
    { fi:15, lat:54.0696, lng:27.5687, border:[[54.0755,27.5587],[54.0755,27.5787],[54.0637,27.5787],[54.0637,27.5587]] },
    { fi:15, lat:54.06902, lng:27.58786, border:[[54.0637,27.5987],[54.0637,27.5787],[54.0755,27.5787],[54.0755,27.589],[54.0723,27.5923],[54.07143,27.5987]] },
    { fi:15, lat:54.06693, lng:27.60799, border:[[54.0637,27.6187],[54.0637,27.5987],[54.07143,27.5987],[54.06871,27.6187]] },
    { fi:15, lat:54.06561, lng:27.62746, border:[[54.0637,27.6387],[54.0637,27.6187],[54.06871,27.6187],[54.06599,27.6387]] },
    { fi:15, lat:54.06916, lng:27.65298, border:[[54.0755,27.6587],[54.0637,27.6587],[54.0637,27.6387],[54.06599,27.6387],[54.064,27.6533],[54.0755,27.64914]] },
    { fi:16, lat:54.0696, lng:27.6687, border:[[54.0755,27.6587],[54.0755,27.6787],[54.0637,27.6787],[54.0637,27.6587]] },
    { fi:16, lat:54.0696, lng:27.6887, border:[[54.0755,27.6787],[54.0755,27.6987],[54.0637,27.6987],[54.0637,27.6787]] },
    { fi:16, lat:54.0696, lng:27.7087, border:[[54.0755,27.6987],[54.0755,27.7187],[54.0637,27.7187],[54.0637,27.6987]] },
    { fi:16, lat:54.0696, lng:27.7287, border:[[54.0755,27.7187],[54.0755,27.7387],[54.0637,27.7387],[54.0637,27.7187]] },
    { fi:16, lat:54.0696, lng:27.7487, border:[[54.0755,27.7387],[54.0755,27.7587],[54.0637,27.7587],[54.0637,27.7387]] },
    { fi:16, lat:54.0696, lng:27.7687, border:[[54.0755,27.7587],[54.0755,27.7787],[54.0637,27.7787],[54.0637,27.7587]] },
    { fi:16, lat:54.0696, lng:27.78869, border:[[54.0637,27.7787],[54.0755,27.7787],[54.0755,27.7987],[54.06501,27.7987],[54.0637,27.79841]] },
    { fi:16, lat:54.072, lng:27.79947, border:[[54.0755,27.7987],[54.0755,27.801],[54.06501,27.7987]] },
    { fi:12, lat:54.08211, lng:27.17398, border:[[54.0755,27.1787],[54.0755,27.1777],[54.0846,27.1646],[54.08683,27.1787]] },
    { fi:13, lat:54.08138, lng:27.18873, border:[[54.0873,27.1987],[54.0755,27.1987],[54.0755,27.1787],[54.08683,27.1787],[54.0873,27.18169]] },
    { fi:13, lat:54.0814, lng:27.2087, border:[[54.0873,27.1987],[54.0873,27.2187],[54.0755,27.2187],[54.0755,27.1987]] },
    { fi:13, lat:54.0814, lng:27.2287, border:[[54.0873,27.2187],[54.0873,27.2387],[54.0755,27.2387],[54.0755,27.2187]] },
    { fi:13, lat:54.0814, lng:27.2487, border:[[54.0873,27.2387],[54.0873,27.2587],[54.0755,27.2587],[54.0755,27.2387]] },
    { fi:13, lat:54.0814, lng:27.2687, border:[[54.0873,27.2587],[54.0873,27.2787],[54.0755,27.2787],[54.0755,27.2587]] },
    { fi:13, lat:54.0814, lng:27.2887, border:[[54.0873,27.2787],[54.0873,27.2987],[54.0755,27.2987],[54.0755,27.2787]] },
    { fi:13, lat:54.0814, lng:27.3087, border:[[54.0873,27.2987],[54.0873,27.3187],[54.0755,27.3187],[54.0755,27.2987]] },
    { fi:13, lat:54.0814, lng:27.3287, border:[[54.0873,27.3187],[54.0873,27.3387],[54.0755,27.3387],[54.0755,27.3187]] },
    { fi:14, lat:54.0814, lng:27.3487, border:[[54.0873,27.3387],[54.0873,27.3587],[54.0755,27.3587],[54.0755,27.3387]] },
    { fi:14, lat:54.0814, lng:27.3687, border:[[54.0873,27.3587],[54.0873,27.3787],[54.0755,27.3787],[54.0755,27.3587]] },
    { fi:14, lat:54.0814, lng:27.3887, border:[[54.0873,27.3787],[54.0873,27.3987],[54.0755,27.3987],[54.0755,27.3787]] },
    { fi:14, lat:54.0814, lng:27.4087, border:[[54.0873,27.3987],[54.0873,27.4187],[54.0755,27.4187],[54.0755,27.3987]] },
    { fi:14, lat:54.0814, lng:27.4287, border:[[54.0873,27.4187],[54.0873,27.4387],[54.0755,27.4387],[54.0755,27.4187]] },
    { fi:14, lat:54.0814, lng:27.4487, border:[[54.0873,27.4387],[54.0873,27.4587],[54.0755,27.4587],[54.0755,27.4387]] },
    { fi:14, lat:54.0814, lng:27.4687, border:[[54.0873,27.4587],[54.0873,27.4787],[54.0755,27.4787],[54.0755,27.4587]] },
    { fi:14, lat:54.0814, lng:27.4887, border:[[54.0873,27.4787],[54.0873,27.4987],[54.0755,27.4987],[54.0755,27.4787]] },
    { fi:15, lat:54.0814, lng:27.5087, border:[[54.0873,27.4987],[54.0873,27.5187],[54.0755,27.5187],[54.0755,27.4987]] },
    { fi:15, lat:54.0814, lng:27.5287, border:[[54.0873,27.5187],[54.0873,27.5387],[54.0755,27.5387],[54.0755,27.5187]] },
    { fi:15, lat:54.0814, lng:27.5487, border:[[54.0873,27.5387],[54.0873,27.5587],[54.0755,27.5587],[54.0755,27.5387]] },
    { fi:15, lat:54.08136, lng:27.56863, border:[[54.0755,27.5787],[54.0755,27.5587],[54.0873,27.5587],[54.0873,27.57685],[54.0855,27.5787]] },
    { fi:15, lat:54.07883, lng:27.58213, border:[[54.0755,27.5787],[54.0855,27.5787],[54.0755,27.589]] },
    { fi:15, lat:54.08176, lng:27.65279, border:[[54.0873,27.6587],[54.0755,27.6587],[54.0755,27.64914],[54.0873,27.64487]] },
    { fi:16, lat:54.0814, lng:27.6687, border:[[54.0873,27.6587],[54.0873,27.6787],[54.0755,27.6787],[54.0755,27.6587]] },
    { fi:16, lat:54.0814, lng:27.6887, border:[[54.0873,27.6787],[54.0873,27.6987],[54.0755,27.6987],[54.0755,27.6787]] },
    { fi:16, lat:54.0814, lng:27.7087, border:[[54.0873,27.6987],[54.0873,27.7187],[54.0755,27.7187],[54.0755,27.6987]] },
    { fi:16, lat:54.0814, lng:27.7287, border:[[54.0873,27.7187],[54.0873,27.7387],[54.0755,27.7387],[54.0755,27.7187]] },
    { fi:16, lat:54.08103, lng:27.74833, border:[[54.0755,27.7587],[54.0755,27.7387],[54.0873,27.7387],[54.0873,27.74414],[54.08512,27.7587]] },
    { fi:16, lat:54.07961, lng:27.76809, border:[[54.0755,27.7787],[54.0755,27.7587],[54.08512,27.7587],[54.08214,27.7787]] },
    { fi:16, lat:54.07814, lng:27.78773, border:[[54.0755,27.7987],[54.0755,27.7787],[54.08214,27.7787],[54.07915,27.7987]] },
    { fi:16, lat:54.07729, lng:27.80001, border:[[54.0755,27.7987],[54.07915,27.7987],[54.0787,27.8017],[54.0755,27.801]] },
    { fi:13, lat:54.0882, lng:27.19303, border:[[54.0873,27.1987],[54.0873,27.18169],[54.08999,27.1987]] },
    { fi:13, lat:54.09051, lng:27.21105, border:[[54.0991,27.2187],[54.0873,27.2187],[54.0873,27.1987],[54.08999,27.1987],[54.0928,27.2165],[54.0991,27.21606]] },
    { fi:13, lat:54.0932, lng:27.2287, border:[[54.0991,27.2187],[54.0991,27.2387],[54.0873,27.2387],[54.0873,27.2187]] },
    { fi:13, lat:54.0932, lng:27.2487, border:[[54.0991,27.2387],[54.0991,27.2587],[54.0873,27.2587],[54.0873,27.2387]] },
    { fi:13, lat:54.0932, lng:27.2687, border:[[54.0991,27.2587],[54.0991,27.2787],[54.0873,27.2787],[54.0873,27.2587]] },
    { fi:13, lat:54.0932, lng:27.2887, border:[[54.0991,27.2787],[54.0991,27.2987],[54.0873,27.2987],[54.0873,27.2787]] },
    { fi:13, lat:54.0932, lng:27.3087, border:[[54.0991,27.2987],[54.0991,27.3187],[54.0873,27.3187],[54.0873,27.2987]] },
    { fi:13, lat:54.0932, lng:27.3287, border:[[54.0991,27.3187],[54.0991,27.3387],[54.0873,27.3387],[54.0873,27.3187]] },
    { fi:14, lat:54.0932, lng:27.3487, border:[[54.0991,27.3387],[54.0991,27.3587],[54.0873,27.3587],[54.0873,27.3387]] },
    { fi:14, lat:54.0932, lng:27.3687, border:[[54.0991,27.3587],[54.0991,27.3787],[54.0873,27.3787],[54.0873,27.3587]] },
    { fi:14, lat:54.0932, lng:27.3887, border:[[54.0991,27.3787],[54.0991,27.3987],[54.0873,27.3987],[54.0873,27.3787]] },
    { fi:14, lat:54.0932, lng:27.4087, border:[[54.0991,27.3987],[54.0991,27.4187],[54.0873,27.4187],[54.0873,27.3987]] },
    { fi:14, lat:54.0932, lng:27.4287, border:[[54.0991,27.4187],[54.0991,27.4387],[54.0873,27.4387],[54.0873,27.4187]] },
    { fi:14, lat:54.0932, lng:27.4487, border:[[54.0991,27.4387],[54.0991,27.4587],[54.0873,27.4587],[54.0873,27.4387]] },
    { fi:14, lat:54.0932, lng:27.4687, border:[[54.0991,27.4587],[54.0991,27.4787],[54.0873,27.4787],[54.0873,27.4587]] },
    { fi:14, lat:54.0932, lng:27.4887, border:[[54.0991,27.4787],[54.0991,27.4987],[54.0873,27.4987],[54.0873,27.4787]] },
    { fi:15, lat:54.0932, lng:27.5087, border:[[54.0991,27.4987],[54.0991,27.5187],[54.0873,27.5187],[54.0873,27.4987]] },
    { fi:15, lat:54.0932, lng:27.5287, border:[[54.0991,27.5187],[54.0991,27.5387],[54.0873,27.5387],[54.0873,27.5187]] },
    { fi:15, lat:54.0932, lng:27.5487, border:[[54.0991,27.5387],[54.0991,27.5587],[54.0873,27.5587],[54.0873,27.5387]] },
    { fi:15, lat:54.09221, lng:27.56524, border:[[54.0873,27.5587],[54.0991,27.5587],[54.0991,27.56469],[54.0873,27.57685]] },
    { fi:15, lat:54.09714, lng:27.632, border:[[54.0991,27.6187],[54.0991,27.6387],[54.09322,27.6387],[54.09907,27.6187]] },
    { fi:15, lat:54.09365, lng:27.64968, border:[[54.0991,27.6387],[54.0991,27.6587],[54.0873,27.6587],[54.0873,27.64487],[54.0919,27.6432],[54.09322,27.6387]] },
    { fi:16, lat:54.0932, lng:27.6687, border:[[54.0991,27.6587],[54.0991,27.6787],[54.0873,27.6787],[54.0873,27.6587]] },
    { fi:16, lat:54.0932, lng:27.6887, border:[[54.0991,27.6787],[54.0991,27.6987],[54.0873,27.6987],[54.0873,27.6787]] },
    { fi:16, lat:54.09298, lng:27.70809, border:[[54.0873,27.7187],[54.0873,27.6987],[54.0991,27.6987],[54.0991,27.71487],[54.0911,27.7187]] },
    { fi:16, lat:54.08861, lng:27.72654, border:[[54.0873,27.7387],[54.0873,27.7187],[54.0911,27.7187],[54.08811,27.7387]] },
    { fi:16, lat:54.08757, lng:27.74051, border:[[54.0873,27.7387],[54.08811,27.7387],[54.0873,27.74414]] },
    { fi:13, lat:54.10526, lng:27.21717, border:[[54.1109,27.2187],[54.0991,27.2187],[54.0991,27.21606],[54.1109,27.21525]] },
    { fi:13, lat:54.105, lng:27.2287, border:[[54.1109,27.2187],[54.1109,27.2387],[54.0991,27.2387],[54.0991,27.2187]] },
    { fi:13, lat:54.105, lng:27.2487, border:[[54.1109,27.2387],[54.1109,27.2587],[54.0991,27.2587],[54.0991,27.2387]] },
    { fi:13, lat:54.105, lng:27.2687, border:[[54.1109,27.2587],[54.1109,27.2787],[54.0991,27.2787],[54.0991,27.2587]] },
    { fi:13, lat:54.105, lng:27.2887, border:[[54.1109,27.2787],[54.1109,27.2987],[54.0991,27.2987],[54.0991,27.2787]] },
    { fi:13, lat:54.105, lng:27.3087, border:[[54.1109,27.2987],[54.1109,27.3187],[54.0991,27.3187],[54.0991,27.2987]] },
    { fi:13, lat:54.105, lng:27.3287, border:[[54.1109,27.3187],[54.1109,27.3387],[54.0991,27.3387],[54.0991,27.3187]] },
    { fi:14, lat:54.105, lng:27.3487, border:[[54.1109,27.3387],[54.1109,27.3587],[54.0991,27.3587],[54.0991,27.3387]] },
    { fi:14, lat:54.105, lng:27.3687, border:[[54.1109,27.3587],[54.1109,27.3787],[54.0991,27.3787],[54.0991,27.3587]] },
    { fi:14, lat:54.105, lng:27.3887, border:[[54.1109,27.3787],[54.1109,27.3987],[54.0991,27.3987],[54.0991,27.3787]] },
    { fi:14, lat:54.105, lng:27.4087, border:[[54.1109,27.3987],[54.1109,27.4187],[54.0991,27.4187],[54.0991,27.3987]] },
    { fi:14, lat:54.105, lng:27.4287, border:[[54.1109,27.4187],[54.1109,27.4387],[54.0991,27.4387],[54.0991,27.4187]] },
    { fi:14, lat:54.105, lng:27.4487, border:[[54.1109,27.4387],[54.1109,27.4587],[54.0991,27.4587],[54.0991,27.4387]] },
    { fi:14, lat:54.105, lng:27.4687, border:[[54.1109,27.4587],[54.1109,27.4787],[54.0991,27.4787],[54.0991,27.4587]] },
    { fi:14, lat:54.105, lng:27.4887, border:[[54.1109,27.4787],[54.1109,27.4987],[54.0991,27.4987],[54.0991,27.4787]] },
    { fi:15, lat:54.105, lng:27.5087, border:[[54.1109,27.4987],[54.1109,27.5187],[54.0991,27.5187],[54.0991,27.4987]] },
    { fi:15, lat:54.105, lng:27.5287, border:[[54.1109,27.5187],[54.1109,27.5387],[54.0991,27.5387],[54.0991,27.5187]] },
    { fi:15, lat:54.105, lng:27.5487, border:[[54.1109,27.5387],[54.1109,27.5587],[54.0991,27.5587],[54.0991,27.5387]] },
    { fi:15, lat:54.10547, lng:27.56118, border:[[54.0991,27.5587],[54.1109,27.5587],[54.1109,27.56534],[54.102,27.5617],[54.0991,27.56469]] },
    { fi:15, lat:54.10237, lng:27.61433, border:[[54.0991,27.6187],[54.0991,27.61859],[54.1029,27.6056],[54.10515,27.6187]] },
    { fi:15, lat:54.10305, lng:27.62944, border:[[54.0991,27.6387],[54.0991,27.6187],[54.10515,27.6187],[54.1086,27.6387]] },
    { fi:15, lat:54.10464, lng:27.64909, border:[[54.1109,27.6587],[54.0991,27.6587],[54.0991,27.6387],[54.1086,27.6387],[54.1109,27.6521]] },
    { fi:16, lat:54.105, lng:27.6687, border:[[54.1109,27.6587],[54.1109,27.6787],[54.0991,27.6787],[54.0991,27.6587]] },
    { fi:16, lat:54.105, lng:27.6887, border:[[54.1109,27.6787],[54.1109,27.6987],[54.0991,27.6987],[54.0991,27.6787]] },
    { fi:16, lat:54.10458, lng:27.70547, border:[[54.0991,27.6987],[54.1109,27.6987],[54.1109,27.70923],[54.0991,27.71487]] },
    { fi:19, lat:54.11701, lng:27.21676, border:[[54.1227,27.2187],[54.1109,27.2187],[54.1109,27.21525],[54.1227,27.21443]] },
    { fi:19, lat:54.1168, lng:27.2287, border:[[54.1227,27.2187],[54.1227,27.2387],[54.1109,27.2387],[54.1109,27.2187]] },
    { fi:19, lat:54.1168, lng:27.2487, border:[[54.1227,27.2387],[54.1227,27.2587],[54.1109,27.2587],[54.1109,27.2387]] },
    { fi:19, lat:54.1168, lng:27.2687, border:[[54.1227,27.2587],[54.1227,27.2787],[54.1109,27.2787],[54.1109,27.2587]] },
    { fi:19, lat:54.1168, lng:27.2887, border:[[54.1227,27.2787],[54.1227,27.2987],[54.1109,27.2987],[54.1109,27.2787]] },
    { fi:19, lat:54.1168, lng:27.3087, border:[[54.1227,27.2987],[54.1227,27.3187],[54.1109,27.3187],[54.1109,27.2987]] },
    { fi:19, lat:54.1168, lng:27.3287, border:[[54.1227,27.3187],[54.1227,27.3387],[54.1109,27.3387],[54.1109,27.3187]] },
    { fi:20, lat:54.1168, lng:27.3487, border:[[54.1227,27.3387],[54.1227,27.3587],[54.1109,27.3587],[54.1109,27.3387]] },
    { fi:20, lat:54.1168, lng:27.3687, border:[[54.1227,27.3587],[54.1227,27.3787],[54.1109,27.3787],[54.1109,27.3587]] },
    { fi:20, lat:54.1168, lng:27.3887, border:[[54.1227,27.3787],[54.1227,27.3987],[54.1109,27.3987],[54.1109,27.3787]] },
    { fi:20, lat:54.1168, lng:27.4087, border:[[54.1227,27.3987],[54.1227,27.4187],[54.1109,27.4187],[54.1109,27.3987]] },
    { fi:20, lat:54.1168, lng:27.4287, border:[[54.1227,27.4187],[54.1227,27.4387],[54.1109,27.4387],[54.1109,27.4187]] },
    { fi:20, lat:54.1168, lng:27.4487, border:[[54.1227,27.4387],[54.1227,27.4587],[54.1109,27.4587],[54.1109,27.4387]] },
    { fi:20, lat:54.1168, lng:27.4687, border:[[54.1227,27.4587],[54.1227,27.4787],[54.1109,27.4787],[54.1109,27.4587]] },
    { fi:20, lat:54.1168, lng:27.4887, border:[[54.1227,27.4787],[54.1227,27.4987],[54.1109,27.4987],[54.1109,27.4787]] },
    { fi:21, lat:54.1168, lng:27.5087, border:[[54.1227,27.4987],[54.1227,27.5187],[54.1109,27.5187],[54.1109,27.4987]] },
    { fi:21, lat:54.1168, lng:27.5287, border:[[54.1227,27.5187],[54.1227,27.5387],[54.1109,27.5387],[54.1109,27.5187]] },
    { fi:21, lat:54.1168, lng:27.5487, border:[[54.1227,27.5387],[54.1227,27.5587],[54.1109,27.5587],[54.1109,27.5387]] },
    { fi:21, lat:54.11731, lng:27.56331, border:[[54.1109,27.5587],[54.1227,27.5587],[54.1227,27.56933],[54.1218,27.5698],[54.1109,27.56534]] },
    { fi:21, lat:54.11128, lng:27.6565, border:[[54.1109,27.6587],[54.1109,27.6521],[54.11204,27.6587]] },
    { fi:22, lat:54.1124, lng:27.67044, border:[[54.1109,27.6787],[54.1109,27.6587],[54.11204,27.6587],[54.1146,27.6736],[54.11456,27.6787]] },
    { fi:22, lat:54.11268, lng:27.68862, border:[[54.1109,27.6987],[54.1109,27.6787],[54.11456,27.6787],[54.11438,27.6987]] },
    { fi:22, lat:54.11257, lng:27.70355, border:[[54.1109,27.6987],[54.11438,27.6987],[54.1143,27.7076],[54.1109,27.70923]] },
    { fi:19, lat:54.12877, lng:27.21635, border:[[54.1345,27.2187],[54.1227,27.2187],[54.1227,27.21443],[54.1345,27.21361]] },
    { fi:19, lat:54.1286, lng:27.2287, border:[[54.1345,27.2187],[54.1345,27.2387],[54.1227,27.2387],[54.1227,27.2187]] },
    { fi:19, lat:54.1286, lng:27.2487, border:[[54.1345,27.2387],[54.1345,27.2587],[54.1227,27.2587],[54.1227,27.2387]] },
    { fi:19, lat:54.1286, lng:27.2687, border:[[54.1345,27.2587],[54.1345,27.2787],[54.1227,27.2787],[54.1227,27.2587]] },
    { fi:19, lat:54.1286, lng:27.2887, border:[[54.1345,27.2787],[54.1345,27.2987],[54.1227,27.2987],[54.1227,27.2787]] },
    { fi:19, lat:54.1286, lng:27.3087, border:[[54.1345,27.2987],[54.1345,27.3187],[54.1227,27.3187],[54.1227,27.2987]] },
    { fi:19, lat:54.1286, lng:27.3287, border:[[54.1345,27.3187],[54.1345,27.3387],[54.1227,27.3387],[54.1227,27.3187]] },
    { fi:20, lat:54.1286, lng:27.3487, border:[[54.1345,27.3387],[54.1345,27.3587],[54.1227,27.3587],[54.1227,27.3387]] },
    { fi:20, lat:54.1286, lng:27.3687, border:[[54.1345,27.3587],[54.1345,27.3787],[54.1227,27.3787],[54.1227,27.3587]] },
    { fi:20, lat:54.1286, lng:27.3887, border:[[54.1345,27.3787],[54.1345,27.3987],[54.1227,27.3987],[54.1227,27.3787]] },
    { fi:20, lat:54.1286, lng:27.4087, border:[[54.1345,27.3987],[54.1345,27.4187],[54.1227,27.4187],[54.1227,27.3987]] },
    { fi:20, lat:54.1286, lng:27.4287, border:[[54.1345,27.4187],[54.1345,27.4387],[54.1227,27.4387],[54.1227,27.4187]] },
    { fi:20, lat:54.1286, lng:27.4487, border:[[54.1345,27.4387],[54.1345,27.4587],[54.1227,27.4587],[54.1227,27.4387]] },
    { fi:20, lat:54.1286, lng:27.4687, border:[[54.1345,27.4587],[54.1345,27.4787],[54.1227,27.4787],[54.1227,27.4587]] },
    { fi:20, lat:54.1286, lng:27.4887, border:[[54.1345,27.4787],[54.1345,27.4987],[54.1227,27.4987],[54.1227,27.4787]] },
    { fi:21, lat:54.1286, lng:27.5087, border:[[54.1345,27.4987],[54.1345,27.5187],[54.1227,27.5187],[54.1227,27.4987]] },
    { fi:21, lat:54.1286, lng:27.5287, border:[[54.1345,27.5187],[54.1345,27.5387],[54.1227,27.5387],[54.1227,27.5187]] },
    { fi:21, lat:54.1286, lng:27.5487, border:[[54.1345,27.5387],[54.1345,27.5587],[54.1227,27.5587],[54.1227,27.5387]] },
    { fi:21, lat:54.1278, lng:27.56269, border:[[54.1227,27.5587],[54.1345,27.5587],[54.1345,27.56317],[54.1227,27.56933]] },
    { fi:19, lat:54.13571, lng:27.21639, border:[[54.1345,27.2187],[54.1345,27.21361],[54.1361,27.2135],[54.13757,27.2187]] },
    { fi:19, lat:54.13767, lng:27.2303, border:[[54.1345,27.2387],[54.1345,27.2187],[54.13757,27.2187],[54.1432,27.2387]] },
    { fi:19, lat:54.14002, lng:27.24918, border:[[54.1345,27.2587],[54.1345,27.2387],[54.1432,27.2387],[54.1463,27.2497],[54.1463,27.25746],[54.14595,27.2587]] },
    { fi:19, lat:54.13896, lng:27.2676, border:[[54.1345,27.2787],[54.1345,27.2587],[54.14595,27.2587],[54.14025,27.2787]] },
    { fi:19, lat:54.13912, lng:27.29085, border:[[54.1463,27.2987],[54.1345,27.2987],[54.1345,27.2787],[54.14025,27.2787],[54.138,27.2866],[54.1463,27.29203]] },
    { fi:19, lat:54.1404, lng:27.3087, border:[[54.1463,27.2987],[54.1463,27.3187],[54.1345,27.3187],[54.1345,27.2987]] },
    { fi:19, lat:54.1404, lng:27.3287, border:[[54.1463,27.3187],[54.1463,27.3387],[54.1345,27.3387],[54.1345,27.3187]] },
    { fi:20, lat:54.1404, lng:27.3487, border:[[54.1463,27.3387],[54.1463,27.3587],[54.1345,27.3587],[54.1345,27.3387]] },
    { fi:20, lat:54.1404, lng:27.3687, border:[[54.1463,27.3587],[54.1463,27.3787],[54.1345,27.3787],[54.1345,27.3587]] },
    { fi:20, lat:54.1404, lng:27.3887, border:[[54.1463,27.3787],[54.1463,27.3987],[54.1345,27.3987],[54.1345,27.3787]] },
    { fi:20, lat:54.1404, lng:27.4087, border:[[54.1463,27.3987],[54.1463,27.4187],[54.1345,27.4187],[54.1345,27.3987]] },
    { fi:20, lat:54.1404, lng:27.4287, border:[[54.1463,27.4187],[54.1463,27.4387],[54.1345,27.4387],[54.1345,27.4187]] },
    { fi:20, lat:54.1404, lng:27.4487, border:[[54.1463,27.4387],[54.1463,27.4587],[54.1345,27.4587],[54.1345,27.4387]] },
    { fi:20, lat:54.1404, lng:27.4687, border:[[54.1463,27.4587],[54.1463,27.4787],[54.1345,27.4787],[54.1345,27.4587]] },
    { fi:20, lat:54.1404, lng:27.4887, border:[[54.1463,27.4787],[54.1463,27.4987],[54.1345,27.4987],[54.1345,27.4787]] },
    { fi:21, lat:54.1404, lng:27.5087, border:[[54.1463,27.4987],[54.1463,27.5187],[54.1345,27.5187],[54.1345,27.4987]] },
    { fi:21, lat:54.1404, lng:27.5287, border:[[54.1463,27.5187],[54.1463,27.5387],[54.1345,27.5387],[54.1345,27.5187]] },
    { fi:21, lat:54.14034, lng:27.54859, border:[[54.1345,27.5587],[54.1345,27.5387],[54.1463,27.5387],[54.1463,27.55702],[54.14308,27.5587]] },
    { fi:21, lat:54.13736, lng:27.56019, border:[[54.1345,27.5587],[54.14308,27.5587],[54.1345,27.56317]] },
    { fi:19, lat:54.14667, lng:27.25359, border:[[54.1463,27.2497],[54.1474,27.2536],[54.1463,27.25746]] },
    { fi:19, lat:54.15341, lng:27.29313, border:[[54.1581,27.2987],[54.1463,27.2987],[54.1463,27.29203],[54.1487,27.2936],[54.1581,27.2821]] },
    { fi:19, lat:54.1522, lng:27.3087, border:[[54.1581,27.2987],[54.1581,27.3187],[54.1463,27.3187],[54.1463,27.2987]] },
    { fi:19, lat:54.1522, lng:27.3287, border:[[54.1581,27.3187],[54.1581,27.3387],[54.1463,27.3387],[54.1463,27.3187]] },
    { fi:20, lat:54.1522, lng:27.3487, border:[[54.1581,27.3387],[54.1581,27.3587],[54.1463,27.3587],[54.1463,27.3387]] },
    { fi:20, lat:54.1522, lng:27.3687, border:[[54.1581,27.3587],[54.1581,27.3787],[54.1463,27.3787],[54.1463,27.3587]] },
    { fi:20, lat:54.1522, lng:27.3887, border:[[54.1581,27.3787],[54.1581,27.3987],[54.1463,27.3987],[54.1463,27.3787]] },
    { fi:20, lat:54.1522, lng:27.4087, border:[[54.1581,27.3987],[54.1581,27.4187],[54.1463,27.4187],[54.1463,27.3987]] },
    { fi:20, lat:54.1522, lng:27.4287, border:[[54.1581,27.4187],[54.1581,27.4387],[54.1463,27.4387],[54.1463,27.4187]] },
    { fi:20, lat:54.1522, lng:27.4487, border:[[54.1581,27.4387],[54.1581,27.4587],[54.1463,27.4587],[54.1463,27.4387]] },
    { fi:20, lat:54.1522, lng:27.4687, border:[[54.1581,27.4587],[54.1581,27.4787],[54.1463,27.4787],[54.1463,27.4587]] },
    { fi:20, lat:54.1522, lng:27.4887, border:[[54.1581,27.4787],[54.1581,27.4987],[54.1463,27.4987],[54.1463,27.4787]] },
    { fi:21, lat:54.1522, lng:27.5087, border:[[54.1581,27.4987],[54.1581,27.5187],[54.1463,27.5187],[54.1463,27.4987]] },
    { fi:21, lat:54.1522, lng:27.5287, border:[[54.1581,27.5187],[54.1581,27.5387],[54.1463,27.5387],[54.1463,27.5187]] },
    { fi:21, lat:54.1524, lng:27.54774, border:[[54.1463,27.5387],[54.1581,27.5387],[54.1581,27.5587],[54.15507,27.5587],[54.1517,27.5542],[54.1463,27.55702]] },
    { fi:21, lat:54.15709, lng:27.56004, border:[[54.1581,27.5587],[54.1581,27.56273],[54.15507,27.5587]] },
    { fi:19, lat:54.16461, lng:27.2771, border:[[54.16088,27.2787],[54.1648,27.2739],[54.16814,27.2787]] },
    { fi:19, lat:54.16405, lng:27.28897, border:[[54.1699,27.2987],[54.1581,27.2987],[54.1581,27.2821],[54.16088,27.2787],[54.16814,27.2787],[54.1699,27.28122]] },
    { fi:19, lat:54.164, lng:27.3087, border:[[54.1699,27.2987],[54.1699,27.3187],[54.1581,27.3187],[54.1581,27.2987]] },
    { fi:19, lat:54.164, lng:27.3287, border:[[54.1699,27.3187],[54.1699,27.3387],[54.1581,27.3387],[54.1581,27.3187]] },
    { fi:20, lat:54.164, lng:27.3487, border:[[54.1699,27.3387],[54.1699,27.3587],[54.1581,27.3587],[54.1581,27.3387]] },
    { fi:20, lat:54.164, lng:27.3687, border:[[54.1699,27.3587],[54.1699,27.3787],[54.1581,27.3787],[54.1581,27.3587]] },
    { fi:20, lat:54.164, lng:27.3887, border:[[54.1699,27.3787],[54.1699,27.3987],[54.1581,27.3987],[54.1581,27.3787]] },
    { fi:20, lat:54.164, lng:27.4087, border:[[54.1699,27.3987],[54.1699,27.4187],[54.1581,27.4187],[54.1581,27.3987]] },
    { fi:20, lat:54.164, lng:27.4287, border:[[54.1699,27.4187],[54.1699,27.4387],[54.1581,27.4387],[54.1581,27.4187]] },
    { fi:20, lat:54.164, lng:27.4487, border:[[54.1699,27.4387],[54.1699,27.4587],[54.1581,27.4587],[54.1581,27.4387]] },
    { fi:20, lat:54.164, lng:27.4687, border:[[54.1699,27.4587],[54.1699,27.4787],[54.1581,27.4787],[54.1581,27.4587]] },
    { fi:20, lat:54.164, lng:27.4887, border:[[54.1699,27.4787],[54.1699,27.4987],[54.1581,27.4987],[54.1581,27.4787]] },
    { fi:21, lat:54.164, lng:27.5087, border:[[54.1699,27.4987],[54.1699,27.5187],[54.1581,27.5187],[54.1581,27.4987]] },
    { fi:21, lat:54.164, lng:27.5287, border:[[54.1699,27.5187],[54.1699,27.5387],[54.1581,27.5387],[54.1581,27.5187]] },
    { fi:21, lat:54.164, lng:27.5487, border:[[54.1699,27.5387],[54.1699,27.5587],[54.1581,27.5587],[54.1581,27.5387]] },
    { fi:21, lat:54.1653, lng:27.56552, border:[[54.1581,27.5587],[54.1699,27.5587],[54.1699,27.57847],[54.1581,27.56273]] },
    { fi:19, lat:54.17395, lng:27.29287, border:[[54.1817,27.2987],[54.1699,27.2987],[54.1699,27.28122],[54.1817,27.29816]] },
    { fi:19, lat:54.1758, lng:27.3087, border:[[54.1817,27.2987],[54.1817,27.3187],[54.1699,27.3187],[54.1699,27.2987]] },
    { fi:19, lat:54.1758, lng:27.3287, border:[[54.1817,27.3187],[54.1817,27.3387],[54.1699,27.3387],[54.1699,27.3187]] },
    { fi:20, lat:54.1758, lng:27.3487, border:[[54.1817,27.3387],[54.1817,27.3587],[54.1699,27.3587],[54.1699,27.3387]] },
    { fi:20, lat:54.1758, lng:27.3687, border:[[54.1817,27.3587],[54.1817,27.3787],[54.1699,27.3787],[54.1699,27.3587]] },
    { fi:20, lat:54.1758, lng:27.3887, border:[[54.1817,27.3787],[54.1817,27.3987],[54.1699,27.3987],[54.1699,27.3787]] },
    { fi:20, lat:54.1758, lng:27.4087, border:[[54.1817,27.3987],[54.1817,27.4187],[54.1699,27.4187],[54.1699,27.3987]] },
    { fi:20, lat:54.1758, lng:27.4287, border:[[54.1817,27.4187],[54.1817,27.4387],[54.1699,27.4387],[54.1699,27.4187]] },
    { fi:20, lat:54.1758, lng:27.4487, border:[[54.1817,27.4387],[54.1817,27.4587],[54.1699,27.4587],[54.1699,27.4387]] },
    { fi:20, lat:54.1758, lng:27.4687, border:[[54.1817,27.4587],[54.1817,27.4787],[54.1699,27.4787],[54.1699,27.4587]] },
    { fi:20, lat:54.1758, lng:27.4887, border:[[54.1817,27.4787],[54.1817,27.4987],[54.1699,27.4987],[54.1699,27.4787]] },
    { fi:21, lat:54.1758, lng:27.5087, border:[[54.1817,27.4987],[54.1817,27.5187],[54.1699,27.5187],[54.1699,27.4987]] },
    { fi:21, lat:54.1758, lng:27.5287, border:[[54.1817,27.5187],[54.1817,27.5387],[54.1699,27.5387],[54.1699,27.5187]] },
    { fi:21, lat:54.1758, lng:27.5487, border:[[54.1817,27.5387],[54.1817,27.5587],[54.1699,27.5587],[54.1699,27.5387]] },
    { fi:21, lat:54.1758, lng:27.56869, border:[[54.1699,27.5587],[54.1817,27.5587],[54.1817,27.57827],[54.1811,27.5787],[54.17007,27.5787],[54.1699,27.57847]] },
    { fi:21, lat:54.17502, lng:27.5804, border:[[54.1811,27.5787],[54.1739,27.5838],[54.17007,27.5787]] },
    { fi:19, lat:54.18718, lng:27.31113, border:[[54.1935,27.3187],[54.1817,27.3187],[54.1817,27.2987],[54.18208,27.2987],[54.1873,27.3062],[54.1935,27.30477]] },
    { fi:19, lat:54.1876, lng:27.3287, border:[[54.1935,27.3187],[54.1935,27.3387],[54.1817,27.3387],[54.1817,27.3187]] },
    { fi:20, lat:54.1876, lng:27.3487, border:[[54.1935,27.3387],[54.1935,27.3587],[54.1817,27.3587],[54.1817,27.3387]] },
    { fi:20, lat:54.1876, lng:27.3687, border:[[54.1935,27.3587],[54.1935,27.3787],[54.1817,27.3787],[54.1817,27.3587]] },
    { fi:20, lat:54.1876, lng:27.3887, border:[[54.1935,27.3787],[54.1935,27.3987],[54.1817,27.3987],[54.1817,27.3787]] },
    { fi:20, lat:54.1876, lng:27.4087, border:[[54.1935,27.3987],[54.1935,27.4187],[54.1817,27.4187],[54.1817,27.3987]] },
    { fi:20, lat:54.1876, lng:27.4287, border:[[54.1935,27.4187],[54.1935,27.4387],[54.1817,27.4387],[54.1817,27.4187]] },
    { fi:20, lat:54.1876, lng:27.4487, border:[[54.1935,27.4387],[54.1935,27.4587],[54.1817,27.4587],[54.1817,27.4387]] },
    { fi:20, lat:54.1876, lng:27.4687, border:[[54.1935,27.4587],[54.1935,27.4787],[54.1817,27.4787],[54.1817,27.4587]] },
    { fi:20, lat:54.18744, lng:27.48845, border:[[54.1817,27.4987],[54.1817,27.4787],[54.1935,27.4787],[54.1935,27.49292],[54.19103,27.4987]] },
    { fi:21, lat:54.18577, lng:27.50882, border:[[54.1817,27.5187],[54.1817,27.4987],[54.19103,27.4987],[54.1889,27.5037],[54.1906,27.5187]] },
    { fi:21, lat:54.18674, lng:27.52908, border:[[54.1817,27.5387],[54.1817,27.5187],[54.1906,27.5187],[54.19287,27.5387]] },
    { fi:21, lat:54.18756, lng:27.54876, border:[[54.1935,27.5587],[54.1817,27.5587],[54.1817,27.5387],[54.19287,27.5387],[54.1935,27.54422]] },
    { fi:21, lat:54.18707, lng:27.56659, border:[[54.1817,27.5587],[54.1935,27.5587],[54.1935,27.56991],[54.1817,27.57827]] },
    { fi:19, lat:54.19958, lng:27.31103, border:[[54.2053,27.3187],[54.1935,27.3187],[54.1935,27.30477],[54.2053,27.30205]] },
    { fi:19, lat:54.1994, lng:27.3287, border:[[54.2053,27.3187],[54.2053,27.3387],[54.1935,27.3387],[54.1935,27.3187]] },
    { fi:20, lat:54.1994, lng:27.3487, border:[[54.2053,27.3387],[54.2053,27.3587],[54.1935,27.3587],[54.1935,27.3387]] },
    { fi:20, lat:54.1994, lng:27.3687, border:[[54.2053,27.3587],[54.2053,27.3787],[54.1935,27.3787],[54.1935,27.3587]] },
    { fi:20, lat:54.1994, lng:27.3887, border:[[54.2053,27.3787],[54.2053,27.3987],[54.1935,27.3987],[54.1935,27.3787]] },
    { fi:20, lat:54.1994, lng:27.4087, border:[[54.2053,27.3987],[54.2053,27.4187],[54.1935,27.4187],[54.1935,27.3987]] },
    { fi:20, lat:54.1994, lng:27.4287, border:[[54.2053,27.4187],[54.2053,27.4387],[54.1935,27.4387],[54.1935,27.4187]] },
    { fi:20, lat:54.1994, lng:27.4487, border:[[54.2053,27.4387],[54.2053,27.4587],[54.1935,27.4587],[54.1935,27.4387]] },
    { fi:20, lat:54.19862, lng:27.46762, border:[[54.1935,27.4787],[54.1935,27.4587],[54.2053,27.4587],[54.2053,27.46527],[54.19957,27.4787]] },
    { fi:20, lat:54.19552, lng:27.48344, border:[[54.1935,27.4787],[54.19957,27.4787],[54.1935,27.49292]] },
    { fi:21, lat:54.19405, lng:27.55387, border:[[54.1935,27.5587],[54.1935,27.54422],[54.19514,27.5587]] },
    { fi:21, lat:54.19458, lng:27.56428, border:[[54.1935,27.5587],[54.19514,27.5587],[54.1962,27.568],[54.1935,27.56991]] },
    { fi:19, lat:54.21004, lng:27.31186, border:[[54.2171,27.3187],[54.2053,27.3187],[54.2053,27.30205],[54.2081,27.3014],[54.2171,27.31458]] },
    { fi:19, lat:54.2112, lng:27.3287, border:[[54.2171,27.3187],[54.2171,27.3387],[54.2053,27.3387],[54.2053,27.3187]] },
    { fi:20, lat:54.2112, lng:27.3487, border:[[54.2171,27.3387],[54.2171,27.3587],[54.2053,27.3587],[54.2053,27.3387]] },
    { fi:20, lat:54.2112, lng:27.3687, border:[[54.2171,27.3587],[54.2171,27.3787],[54.2053,27.3787],[54.2053,27.3587]] },
    { fi:20, lat:54.2112, lng:27.3887, border:[[54.2171,27.3787],[54.2171,27.3987],[54.2053,27.3987],[54.2053,27.3787]] },
    { fi:20, lat:54.2112, lng:27.4087, border:[[54.2171,27.3987],[54.2171,27.4187],[54.2053,27.4187],[54.2053,27.3987]] },
    { fi:20, lat:54.2112, lng:27.4287, border:[[54.2171,27.4187],[54.2171,27.4387],[54.2053,27.4387],[54.2053,27.4187]] },
    { fi:20, lat:54.2101, lng:27.44639, border:[[54.2053,27.4587],[54.2053,27.4387],[54.2171,27.4387],[54.2171,27.44766],[54.2128,27.4477],[54.20811,27.4587]] },
    { fi:20, lat:54.20624, lng:27.46089, border:[[54.2053,27.4587],[54.20811,27.4587],[54.2053,27.46527]] },
    { fi:19, lat:54.21804, lng:27.31733, border:[[54.2171,27.3187],[54.2171,27.31458],[54.21992,27.3187]] },
    { fi:19, lat:54.22203, lng:27.33058, border:[[54.2289,27.3387],[54.2171,27.3387],[54.2171,27.3187],[54.21992,27.3187],[54.2289,27.33185]] },
    { fi:20, lat:54.223, lng:27.3487, border:[[54.2289,27.3387],[54.2289,27.3587],[54.2171,27.3587],[54.2171,27.3387]] },
    { fi:20, lat:54.223, lng:27.3687, border:[[54.2289,27.3587],[54.2289,27.3787],[54.2171,27.3787],[54.2171,27.3587]] },
    { fi:20, lat:54.223, lng:27.3887, border:[[54.2289,27.3787],[54.2289,27.3987],[54.2171,27.3987],[54.2171,27.3787]] },
    { fi:20, lat:54.223, lng:27.4087, border:[[54.2289,27.3987],[54.2289,27.4187],[54.2171,27.4187],[54.2171,27.3987]] },
    { fi:20, lat:54.223, lng:27.4287, border:[[54.2289,27.4187],[54.2289,27.4387],[54.2171,27.4387],[54.2171,27.4187]] },
    { fi:20, lat:54.22299, lng:27.44315, border:[[54.2171,27.4387],[54.2289,27.4387],[54.2289,27.44755],[54.2171,27.44766]] },
    { fi:19, lat:54.2333, lng:27.33702, border:[[54.2407,27.3387],[54.2289,27.3387],[54.2289,27.33185],[54.2331,27.338],[54.2407,27.33658]] },
    { fi:20, lat:54.23419, lng:27.34799, border:[[54.2289,27.3587],[54.2289,27.3387],[54.2407,27.3387],[54.2407,27.3466],[54.236,27.3556],[54.24019,27.3587]] },
    { fi:20, lat:54.2348, lng:27.3687, border:[[54.2407,27.3787],[54.2289,27.3787],[54.2289,27.3587],[54.24019,27.3587],[54.2407,27.35908]] },
    { fi:20, lat:54.2348, lng:27.3887, border:[[54.2407,27.3787],[54.2407,27.3987],[54.2289,27.3987],[54.2289,27.3787]] },
    { fi:20, lat:54.2348, lng:27.4087, border:[[54.2407,27.3987],[54.2407,27.4187],[54.2289,27.4187],[54.2289,27.3987]] },
    { fi:20, lat:54.23431, lng:27.42787, border:[[54.2289,27.4387],[54.2289,27.4187],[54.2407,27.4187],[54.2407,27.43225],[54.2379,27.4311],[54.23623,27.4387]] },
    { fi:20, lat:54.2321, lng:27.44289, border:[[54.2289,27.4387],[54.23623,27.4387],[54.2343,27.4475],[54.2289,27.44755]] },
    { fi:19, lat:54.24335, lng:27.33729, border:[[54.2407,27.3387],[54.2407,27.33658],[54.2465,27.3355],[54.24483,27.3387]] },
    { fi:20, lat:54.24208, lng:27.34133, border:[[54.2407,27.3387],[54.24483,27.3387],[54.2407,27.3466]] },
    { fi:20, lat:54.24594, lng:27.37087, border:[[54.2525,27.3787],[54.2407,27.3787],[54.2407,27.35908],[54.2518,27.3673],[54.2525,27.37581]] },
    { fi:20, lat:54.2466, lng:27.3887, border:[[54.2525,27.3787],[54.2525,27.3987],[54.2407,27.3987],[54.2407,27.3787]] },
    { fi:20, lat:54.2466, lng:27.4087, border:[[54.2525,27.3987],[54.2525,27.4187],[54.2407,27.4187],[54.2407,27.3987]] },
    { fi:20, lat:54.2469, lng:27.42675, border:[[54.2407,27.4187],[54.2525,27.4187],[54.2525,27.43712],[54.2407,27.43225]] },
    { fi:20, lat:54.25314, lng:27.39129, border:[[54.2525,27.3987],[54.2525,27.3787],[54.25274,27.3787],[54.25438,27.3987]] },
    { fi:20, lat:54.25369, lng:27.40897, border:[[54.2525,27.4187],[54.2525,27.3987],[54.25438,27.3987],[54.2551,27.4074],[54.25484,27.4187]] },
    { fi:20, lat:54.25357, lng:27.42779, border:[[54.2525,27.4187],[54.25484,27.4187],[54.2544,27.4379],[54.2525,27.43712]] },
  ];
  var WX_LABELS = [
    { fi:3, lat:53.66142, lng:27.54348 },
    { fi:2, lat:53.73006, lng:27.42686 },
    { fi:3, lat:53.73006, lng:27.54348 },
    { fi:4, lat:53.73006, lng:27.6601 },
    { fi:8, lat:53.79871, lng:27.42686 },
    { fi:9, lat:53.79871, lng:27.54348 },
    { fi:10, lat:53.79871, lng:27.6601 },
    { fi:10, lat:53.79871, lng:27.77671 },
    { fi:11, lat:53.79871, lng:27.89333 },
    { fi:7, lat:53.86735, lng:27.31024 },
    { fi:8, lat:53.86735, lng:27.42686 },
    { fi:9, lat:53.86735, lng:27.54348 },
    { fi:10, lat:53.86735, lng:27.6601 },
    { fi:10, lat:53.86735, lng:27.77671 },
    { fi:6, lat:53.93599, lng:27.07701 },
    { fi:7, lat:53.93599, lng:27.19363 },
    { fi:7, lat:53.93599, lng:27.31024 },
    { fi:8, lat:53.93599, lng:27.42686 },
    { fi:9, lat:53.93599, lng:27.54348 },
    { fi:10, lat:53.93599, lng:27.6601 },
    { fi:10, lat:53.93599, lng:27.77671 },
    { fi:11, lat:53.93599, lng:27.89333 },
    { fi:13, lat:54.00464, lng:27.19363 },
    { fi:13, lat:54.00464, lng:27.31024 },
    { fi:14, lat:54.00464, lng:27.42686 },
    { fi:15, lat:54.00464, lng:27.54348 },
    { fi:16, lat:54.00464, lng:27.6601 },
    { fi:16, lat:54.00464, lng:27.77671 },
    { fi:13, lat:54.07328, lng:27.19363 },
    { fi:13, lat:54.07328, lng:27.31024 },
    { fi:14, lat:54.07328, lng:27.42686 },
    { fi:15, lat:54.07328, lng:27.54348 },
    { fi:16, lat:54.07328, lng:27.6601 },
    { fi:16, lat:54.07328, lng:27.77671 },
    { fi:19, lat:54.14192, lng:27.31024 },
    { fi:20, lat:54.14192, lng:27.42686 },
    { fi:21, lat:54.14192, lng:27.54348 },
    { fi:19, lat:54.21056, lng:27.31024 },
    { fi:20, lat:54.21056, lng:27.42686 },
  ];
  var WX_FETCH = [[53.7071,27.0987],[53.7071,27.2587],[53.7071,27.4187],[53.7071,27.5787],[53.7071,27.7387],[53.7071,27.8987],[53.8671,27.0987],[53.8671,27.2587],[53.8671,27.4187],[53.8671,27.5787],[53.8671,27.7387],[53.8671,27.8987],[54.0271,27.0987],[54.0271,27.2587],[54.0271,27.4187],[54.0271,27.5787],[54.0271,27.7387],[54.0271,27.8987],[54.1871,27.0987],[54.1871,27.2587],[54.1871,27.4187],[54.1871,27.5787],[54.1871,27.7387],[54.1871,27.8987]];
  var WX_LAYERS = [
    { id:'temp',     name:'Температура', ic:'🌡', col:'#f59e0b' },
    { id:'rain',     name:'Дождь',       ic:'🌧', col:'#38bdf8' },
    { id:'snow',     name:'Снег',        ic:'❄', col:'#7dd3fc' },
    { id:'wind',     name:'Ветер',       ic:'💨', col:'#a78bfa' }
  ];

  var WXM = null; // состояние карты погоды

  function tempColor(t) {
    if (t == null) return '#94a3b8';
    if (t < -10) return '#1d4ed8';
    if (t < 0) return '#3b82f6';
    if (t < 8) return '#06b6d4';
    if (t < 15) return '#10b981';
    if (t < 22) return '#84cc16';
    if (t < 28) return '#f59e0b';
    if (t < 33) return '#f97316';
    return '#dc2626';
  }
  function pollenLabel(sum) {
    if (sum == null) return 'нет данных';
    if (sum <= 0) return 'нет';
    if (sum < 10) return 'низкая';
    if (sum < 100) return 'средняя';
    return 'высокая';
  }

  function openWeatherMap() {
    // Убираем старую карту, если была
    if (WXM && WXM.map) { try { WXM.map.remove(); } catch (e) {} }
    if (window._wxMap) { try { window._wxMap.remove(); } catch (e) {} window._wxMap = null; }
    stopWxRadarAnim();
    var ov = document.getElementById('wx-map-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'wx-map-overlay';
      document.body.appendChild(ov);
      ov.addEventListener('click', function (e) { if (e.target === ov) closeWeatherMap(); });
    }
    // ВСЕГДА пересоздаём содержимое → свежий #wx-map-canvas без устаревшего Leaflet-id (фикс повторного открытия)
    ov.innerHTML = '<div id="wx-map-window">' +
      '<div id="wx-map-header">' +
        '<span class="wx-title">🗺 Карта погоды · Минск и Минский район</span>' +
        '<div id="wx-basemap-sel">' +
          '<button class="wx-bm-btn on" data-action="wx-basemap" data-bm="osm">OSM</button>' +
          '<button class="wx-bm-btn" data-action="wx-basemap" data-bm="google">Google</button>' +
          '<button class="wx-bm-btn" data-action="wx-basemap" data-bm="yandex" title="Яндекс.Карта (проекция EPSG:3395)">Яндекс</button>' +
        '</div>' +
        '<button id="wx-map-close" class="x" data-action="close-wx-map" title="Закрыть">×</button>' +
      '</div>' +
      '<div id="wx-map-body">' +
        '<div id="wx-loading">Загрузка карты погоды…</div>' +
        '<div id="wx-map-canvas" style="display:none"></div>' +
        '<div id="wx-particles" style="display:none"></div>' +
        '<div id="wx-layers" class="wx-layers"></div>' +
        '<div id="wx-timeline" class="wx-timeline"></div>' +
      '</div>' +
    '</div>';
    ov.classList.add('show');
    WXM = {
      map: null, basemap: 'osm', baseLayer: null,
      layers: { temp: true, rain: true, snow: false, wind: false, pressure: false },
      hour: (function () { var h = new Date().getHours(); return Math.max(0, Math.min(47, h)); })(),
      day0epoch: Math.floor(new Date().setHours(0, 0, 0, 0) / 1000),
      frames: [], host: '', pastCount: 0, radarPos: 0,
      radarLayer: null, radarTm: null,
      regionGroup: null, cellGroup: null, labelGroup: null, stormGroup: null, dropGroup: null, rainGroup: null,
      fetchData: {}, playTm: null
    };
    buildWxLayerPanel();
    buildWxTimeline();
    ensureLeaflet(initWxMap);
  }

  function closeWeatherMap() {
    stopWxRadarAnim();
    if (WXM) {
      if (WXM.playTm) { clearInterval(WXM.playTm); WXM.playTm = null; }
      if (WXM.map) { try { WXM.map.remove(); } catch (e) {} }
      WXM = null;
    }
    if (window._wxMap) { try { window._wxMap.remove(); } catch (e) {} window._wxMap = null; }
    var ov = document.getElementById('wx-map-overlay');
    if (ov) ov.classList.remove('show');
  }


  // Левая верхняя панель выбора слоёв (мультивыбор)
  function buildWxLayerPanel() {
    var box = document.getElementById('wx-layers');
    if (!box || !WXM) return;
    var html = '<div class="wx-l-head">🎛 Слои<button class="wx-l-toggle" data-action="wx-layers-toggle" title="Свернуть">▾</button></div>';
    html += '<div class="wx-l-body"><div class="wx-l-sub">Можно выбрать несколько</div>';
    WX_LAYERS.forEach(function (L) {
      var on = WXM.layers[L.id] ? ' on' : '';
      html += '<div class="wx-layer-item' + on + '" data-action="wx-toggle-layer" data-layer="' + L.id + '">' +
        '<span class="wx-l-ic" style="background:' + L.col + '22;color:' + L.col + '">' + L.ic + '</span>' +
        '<span class="wx-l-name">' + L.name + '</span><span class="wx-l-box"></span></div>';
    });
    html += '</div>';
    box.innerHTML = html;
  }

  // Нижний таймлайн (48 часов)
  function buildWxTimeline() {
    var box = document.getElementById('wx-timeline');
    if (!box || !WXM) return;
    var html = '<div class="wx-tl-top"><div><div class="wx-tl-date" id="wx-tl-date">—</div><div class="wx-tl-sub" id="wx-tl-sub"></div></div>' +
      '<div class="wx-tl-btns"><button class="wx-tl-btn" data-action="wx-tl-prev" title="Назад">‹</button>' +
      '<button class="wx-tl-btn" data-action="wx-tl-play" title="Воспроизвести">▶</button>' +
      '<button class="wx-tl-btn" data-action="wx-tl-next" title="Вперёд">›</button></div></div>';
    html += '<div class="wx-tl-slider-wrap"><input type="range" class="wx-tl-slider" id="wx-tl-slider" min="0" max="47" step="1" value="' + WXM.hour + '"></div>';
    html += '<div class="wx-tl-ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>Завтра 00</span><span>06</span><span>12</span><span>18</span></div>';
    box.innerHTML = html;
    var sl = document.getElementById('wx-tl-slider');
    if (sl) sl.addEventListener('input', function () { setWxHour(parseInt(sl.value, 10)); });
    updateWxTimelineLabel();
  }

  function updateWxTimelineLabel() {
    var dEl = document.getElementById('wx-tl-date');
    var sEl = document.getElementById('wx-tl-sub');
    if (!dEl || !WXM) return;
    var h = WXM.hour, hh = h % 24, day = (h < 24) ? 0 : 1;
    var dayName = (day === 0) ? 'Сегодня' : 'Завтра';
    dEl.textContent = dayName + ', ' + String(hh).padStart(2, '0') + ':00';
    var nowH = new Date().getHours();
    if (day === 0 && hh === nowH) dEl.textContent = 'Сейчас, ' + String(hh).padStart(2, '0') + ':00';
    if (sEl) sEl.textContent = '';
  }

  function setWxHour(h) {
    if (!WXM) return;
    WXM.hour = Math.max(0, Math.min(47, h));
    var sl = document.getElementById('wx-tl-slider');
    if (sl) sl.value = WXM.hour;
    updateWxTimelineLabel();
    renderWxHour();
  }

  function toggleWxPlay() {
    var btn = document.querySelector('[data-action="wx-tl-play"]');
    if (!WXM) return;
    if (WXM.playTm) { clearInterval(WXM.playTm); WXM.playTm = null; if (btn) { btn.textContent = '▶'; btn.classList.remove('on'); } return; }
    if (btn) { btn.textContent = '❚❚'; btn.classList.add('on'); }
    WXM.playTm = setInterval(function () { var nh = WXM.hour + 1; if (nh > 47) nh = 0; setWxHour(nh); }, 800);
  }

  // Подложка: стандартный OSM или Google Maps
  function setWxBasemap(bm) {
    if (!WXM) return;
    var prev = WXM.basemap;
    WXM.basemap = bm;
    // Смена проекции (Яндекс EPSG:3395 <-> OSM/Google EPSG:3857) — пересоздаём карту.
    if (!WXM.map || (prev === 'yandex') !== (bm === 'yandex')) {
      buildWxMapCanvas();
      return;
    }
    // Та же проекция (OSM <-> Google) — просто меняем слой подложки.
    if (WXM.baseLayer) { try { WXM.map.removeLayer(WXM.baseLayer); } catch (e) {} }
    var url, sub, attr;
    if (bm === 'google') { url = 'https://mt{s}.google.com/vt/lyrs=m&hl=ru&x={x}&y={y}&z={z}'; sub = ['0', '1', '2', '3']; attr = 'Google'; }
    else { url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; sub = ['a', 'b', 'c']; attr = 'OSM'; }
    WXM.baseLayer = window.L.tileLayer(url, { subdomains: sub, maxZoom: 19, maxNativeZoom: 19, attribution: attr }).addTo(WXM.map);
    document.querySelectorAll('.wx-bm-btn').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-bm') === bm); });
  }

  function initWxMap() {
    if (!window.L) { var ld = document.getElementById('wx-loading'); if (ld) ld.textContent = 'Не удалось загрузить карту'; return; }
    var canvas = document.getElementById('wx-map-canvas');
    if (!canvas) return;
    var loadingEl = document.getElementById('wx-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    canvas.style.display = 'block';
    buildWxMapCanvas();
    loadWxRadar();
    loadWxRegionData();
  }

  // Создание/пересоздание карты погоды с учётом проекции подложки.
  // Яндекс — EPSG:3395, OSM/Google — EPSG:3857. При смене проекции карту нужно
  // пересоздать, поэтому вся инициализация (карта, pane, группы, подложка) — здесь.
  function buildWxMapCanvas() {
    if (!WXM || !window.L) return;
    stopWxRadarAnim();
    if (WXM.map) { try { WXM.map.remove(); } catch (e) {} }
    window._wxMap = null; WXM.map = null; WXM.baseLayer = null; WXM.radarLayer = null;
    var canvas = document.getElementById('wx-map-canvas');
    if (!canvas) return;
    canvas.innerHTML = '';
    try { delete canvas._leaflet_id; } catch (e) { try { canvas._leaflet_id = null; } catch (e2) {} }
    var useYandex = (WXM.basemap === 'yandex');
    var mapOpts = { center: [53.9023, 27.5619], zoom: 10, minZoom: 7, maxZoom: 16, attributionControl: false, zoomControl: true };
    if (useYandex && window.L.CRS && window.L.CRS.EPSG3395) mapOpts.crs = window.L.CRS.EPSG3395;
    var map = window.L.map('wx-map-canvas', mapOpts);
    window._wxMap = map; WXM.map = map;
    map.on('zoomend', function () { renderWxHour(); });
    map.on('moveend', function () { if (WXM) renderWxCellParticles(!!WXM._pR, !!WXM._pS); });
    WXM.radarPane = map.createPane('wxradar'); WXM.radarPane.style.zIndex = 450;
    var stormPane = map.createPane('wxstorm'); stormPane.style.zIndex = 460;
    WXM.regionGroup = window.L.layerGroup().addTo(map);
    WXM.cellGroup = window.L.layerGroup().addTo(map);
    WXM.labelGroup = window.L.layerGroup().addTo(map);
    WXM.stormGroup = window.L.layerGroup().addTo(map);
    WXM.dropGroup = window.L.layerGroup().addTo(map);
    if (!document.getElementById('wxRound')) {
      var fsv = document.createElement('div'); fsv.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      fsv.innerHTML = '<svg><defs><filter id="wxRound" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b"/><feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/></filter></defs></svg>';
      document.body.appendChild(fsv);
    }
    var rainPane = map.createPane('wxrain'); rainPane.style.zIndex = 410; rainPane.classList.add('wxrain-pane');
    WXM.rainGroup = window.L.layerGroup().addTo(map);
    WXM.cellLayers = null; WXM.regionBuilt = false; WXM.radarCache = {};
    var url, sub, attr;
    if (useYandex) {
      url = 'https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}'; sub = ['1', '2', '3', '4']; attr = '© Яндекс';
    } else if (WXM.basemap === 'google') {
      url = 'https://mt{s}.google.com/vt/lyrs=m&hl=ru&x={x}&y={y}&z={z}'; sub = ['0', '1', '2', '3']; attr = 'Google';
    } else {
      url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; sub = ['a', 'b', 'c']; attr = 'OSM';
    }
    WXM.baseLayer = window.L.tileLayer(url, { subdomains: sub, maxZoom: 19, maxNativeZoom: 19, attribution: attr }).addTo(map);
    document.querySelectorAll('.wx-bm-btn').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-bm') === WXM.basemap); });
    // Радар RainViewer — в проекции EPSG:3857. На Яндекс-подложке (EPSG:3395) он был бы
    // смещён (~35 км), поэтому там его не показываем. Ячейки погоды работают на любой подложке.
    if (!useYandex && WXM.frames && WXM.frames.length) {
      startWxRadarAnim();
    } else if (useYandex) {
      WXM.radarPane.style.display = 'none';
    }
    renderWxHour();
    setTimeout(function () { map.invalidateSize(); }, 60);
    setTimeout(function () { map.invalidateSize(); }, 250);
    if (useYandex) { try { toast('info', 'Подложка: Яндекс. Радар дождя на ней отключён (разные проекции карт), ячейки погоды работают корректно.'); } catch (e) {} }
  }

  // Радар RainViewer — отдельный анимированный слой дождя поверх карты
  function loadWxRadar() {
    if (!WXM || !WXM.map) return;
    fetch('https://api.rainviewer.com/public/weather-maps.json').then(function (r) { return r.json(); }).then(function (data) {
      if (!WXM || !WXM.map) return;
      WXM.host = data.host;
      var past = (data.radar && data.radar.past) ? data.radar.past : [];
      var now = (data.radar && data.radar.nowcast) ? data.radar.nowcast : [];
      WXM.frames = past.concat(now);
      WXM.pastCount = past.length;
      WXM.radarPos = WXM.frames.length - 1;
      startWxRadarAnim();
    }).catch(function () {});
  }
  function showRadarFrame(idx) {
    if (!WXM || !WXM.map || !WXM.frames.length) return;
    if (WXM.radarLayer) { WXM.radarLayer.setOpacity(0); }
    var fr = WXM.frames[idx]; if (!fr) return;
    if (!WXM.radarCache) WXM.radarCache = {};
    var hostBase = WXM.host.replace('tilecache.rainviewer.com', '{s}.tilecache.rainviewer.com');
    var u = hostBase + fr.path + '/256/{z}/{x}/{y}/2/1_1.png';
    if (!WXM.radarCache[idx]) {
      WXM.radarCache[idx] = window.L.tileLayer(u, {
        opacity: 0, tileSize: 256, pane: 'wxradar', maxNativeZoom: 10, maxZoom: 16,
        subdomains: ['a','b','c'], className: 'wx-radar-tile', keepBuffer: 4
      });
      WXM.radarCache[idx].on('tileerror', function (ev) { if (ev.tile) ev.tile.style.display = 'none'; });
      WXM.radarCache[idx].addTo(WXM.map);
    }
    WXM.radarCache[idx].setOpacity(0.55);
    WXM.radarLayer = WXM.radarCache[idx];
  }
  function startWxRadarAnim() {
    stopWxRadarAnim();
    if (!WXM || !WXM.frames.length) return;
    var mf = Math.min(8, WXM.frames.length);
    WXM.frames = WXM.frames.slice(-mf);
    WXM.radarPos = 0; WXM.radarCache = {};
    showRadarFrame(WXM.radarPos);
    WXM.radarTm = setInterval(function () {
      if (!WXM || !WXM.frames.length) return;
      WXM.radarPos = (WXM.radarPos + 1) % WXM.frames.length;
      showRadarFrame(WXM.radarPos);
    }, 2000);
  }
  function stopWxRadarAnim() { if (WXM && WXM.radarTm) { clearInterval(WXM.radarTm); WXM.radarTm = null; } }

  // Загрузка погоды по сетке точек (13 запросов); ячейки берут ближайшую точку
  function loadWxRegionData() {
    if (!WXM) return;
    WX_FETCH.forEach(function (p, fi) {
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p[0] + '&longitude=' + p[1] +
        '&hourly=temperature_2m,precipitation,rain,snowfall,weather_code,wind_speed_10m,surface_pressure,precipitation_probability' +
        '&timezone=Europe%2FMinsk&forecast_days=2';
      fetch(url).then(function (resp) { return resp.json(); }).then(function (j) {
        if (!WXM || !j || !j.hourly) return;
        var h = j.hourly, arr = [];
        for (var i = 0; i < 48; i++) {
          var code = h.weather_code ? (h.weather_code[i] || 0) : 0;
          arr.push({
            temp: h.temperature_2m ? h.temperature_2m[i] : null,
            rain: (h.rain ? h.rain[i] : 0) || 0,
            snow: (h.snowfall ? h.snowfall[i] : 0) || 0,
            wind: (h.wind_speed_10m ? h.wind_speed_10m[i] : 0) || 0,
            pressure: h.surface_pressure ? h.surface_pressure[i] : null,
            prob: (h.precipitation_probability ? h.precipitation_probability[i] : 0) || 0,
            code: code, desc: decodeWeatherCode(code).desc
          });
        }
        WXM.fetchData[fi] = arr;
        renderWxHour();
      }).catch(function () {});
    });
  }

  function wxWindColor(w) {
    if (w == null) return '#a78bfa';
    if (w < 10) return '#c4b5fd';
    if (w < 20) return '#a78bfa';
    if (w < 30) return '#7c3aed';
    return '#5b21b6';
  }
  function wxPressureColor(p) {
    if (p == null) return '#34d399';
    if (p < 990) return '#059669';
    if (p < 1005) return '#10b981';
    if (p < 1018) return '#34d399';
    return '#6ee7b7';
  }
  // Стиль ячейки по активным слоям: осадки → температура → ветер → давление
  // Дождь/снег НЕ меняют цвет ячеек — осадки показаны отдельным облачным слоем
  // (анимированный радар RainViewer, pane wxradar, z-index 450) поверх ячеек,
  // как отображение дождя в Яндекс.Карте. Цвет ячейки = только температура/ветер/давление.
  // Стиль квадрата сетки. Приоритет заливки: дождь > снег > температура.
  // Ветер отдельной анимацией частиц (updateWxParticles), давление удалено.
  function regionStyle(rec) {
    var base = 'wx-g-cell';
    if (WXM.layers.rain && rec && rec.rain > 0) return { fill: '#3b82f6', op: 0.3, stroke: '#38bdf8', weight: 1.5, cls: base + ' wx-g-rain' };
    if (WXM.layers.snow && rec && rec.snow > 0) return { fill: '#94a3b8', op: 0.32, stroke: '#cbd5e1', weight: 1.5, cls: base + ' wx-g-snow' };
    if (WXM.layers.temp && rec && rec.temp != null) return { fill: tempColor(rec.temp), op: 0.5, stroke: '#0f2740', weight: 0.4, cls: base };
    return { fill: '#3b82f6', op: 0.12, stroke: '#2563eb', weight: 0.4, cls: base };
  }

  // Отрисовка: окантовки Минск+Минский район + ячейки сетки + метки
  function renderWxHour() {
    if (!WXM || !WXM.map) return;
    var map = WXM.map, h = WXM.hour;
    if (!WXM.regionBuilt) {
      WXM.regionGroup.clearLayers();
      WX_REGIONS.forEach(function (r) {
        WXM.regionGroup.addLayer(window.L.polygon(r.border, { color: '#0ea5e9', weight: 4, opacity: 0.95, fill: false, lineJoin: 'round', className: 'wx-region-outline', interactive: false }));
      });
      WXM.regionBuilt = true;
    }
    var anyOn = WX_LAYERS.some(function (L) { return WXM.layers[L.id]; });
    // Мелкие квадраты сетки: создаём ОДИН РАЗ, затем setStyle на тех же элементах →
    // CSS-transition (.wx-g-cell { transition: fill .8s }) плавно меняет цвет температуры.
    if (!WXM.cellLayers) {
      WXM.cellLayers = [];
      WX_CELLS.forEach(function (c) {
        var rect = window.L.polygon(c.border, { stroke: false, fillColor: '#3b82f6', fillOpacity: 0.12, className: 'wx-g-cell', lineJoin: 'miter', interactive: false });
        WXM.cellGroup.addLayer(rect);
        WXM.cellLayers.push({ rect: rect, fi: c.fi, border: c.border });
      });
    }
    var hasRain = false, hasSnow = false;
    WXM.rainGroup.clearLayers();
    WXM.cellLayers.forEach(function (cl) {
      var rec = WXM.fetchData[cl.fi] ? WXM.fetchData[cl.fi][h] : null;
      if (rec && rec.rain > 0) hasRain = true;
      if (rec && rec.snow > 0) hasSnow = true;
      var isRainy = anyOn && WXM.layers.rain && rec && rec.rain > 0;
      if (isRainy) {
        // Сам квадрат прозрачный; синяя заливка переносится в группу wxrain,
        // к которой применён SVG-фильтр gooey — он склеивает соседние квадраты
        // в единую фигуру и ЗАКРУГЛЯЕТ её углы.
        cl.rect.setStyle({ fillColor: '#3b82f6', fillOpacity: 0 });
        WXM.rainGroup.addLayer(window.L.polygon(cl.border, { pane: 'wxrain', stroke: false, fillColor: '#3b82f6', fillOpacity: 0.65, className: 'wx-g-rain', lineJoin: 'round', interactive: false }));
      } else {
        var st = regionStyle(rec);
        cl.rect.setStyle({ fillColor: st.fill, fillOpacity: st.op });
        var el = cl.rect.getElement && cl.rect.getElement();
        if (el) el.setAttribute('class', st.cls);
      }
    });
    // Частицы (дождь/снег/ветер) — общий слой поверх квадратов
    WXM._pR = !!(anyOn && WXM.layers.rain && hasRain);
    WXM._pS = !!(anyOn && WXM.layers.snow && hasSnow);
    renderWxCellParticles(WXM._pR, WXM._pS);
    updateWxParticles(anyOn && WXM.layers.wind);
    // Метки — только в основных районах (WX_LABELS, ~40 точек пропорционально по карте)
    WXM.labelGroup.clearLayers();
    if (anyOn) {
      WX_LABELS.forEach(function (p) {
        var rec = WXM.fetchData[p.fi] ? WXM.fetchData[p.fi][h] : null;
        if (!rec) return;
        var rows = '';
        if (WXM.layers.temp && rec.temp != null) rows += wxValRow('🌡', Math.round(rec.temp) + '°', tempColor(rec.temp));
        if (WXM.layers.rain) rows += wxValRow('🌧', rec.rain > 0 ? (Math.round(rec.rain * 10) / 10) + '' : '0', '#e0f2fe');
        if (WXM.layers.snow) rows += wxValRow('❄', rec.snow > 0 ? (Math.round(rec.snow * 10) / 10) + '' : '0', '#bae6fd');
        if (WXM.layers.wind) rows += wxValRow('💨', Math.round(rec.wind), '#ddd6fe');
        var lh = '<div class="wx-cell-label"><div class="wx-cl-vals">' + rows + '</div></div>';
        WXM.labelGroup.addLayer(window.L.marker([p.lat, p.lng], { icon: window.L.divIcon({ html: lh, className: '', iconSize: [60, 0], iconAnchor: [30, 0] }), interactive: false, zIndexOffset: 600 }));
      });
    }
    WXM.stormGroup.clearLayers();
    if (anyOn) {
      for (var fi in WXM.fetchData) {
        var sr = WXM.fetchData[fi][h];
        if (sr && sr.code >= 95) {
          var sp = WX_FETCH[parseInt(fi, 10)];
          WXM.stormGroup.addLayer(window.L.circle([sp[0], sp[1]], { radius: 7500, pane: 'wxstorm', color: '#1e3a8a', weight: 2, opacity: 0.7, fillColor: '#1e3a8a', fillOpacity: 0.4, className: 'wx-storm-circle', interactive: false }));
        }
      }
    }
  }

  // Общий слой частиц поверх квадратов: дождь (капли), снег (снежинки), ветер (полосы).
  // Ветер — общий слой полос по всей карте (дождь/снег теперь per-cell).
  function updateWxParticles(wind) {
    var box = document.getElementById('wx-particles');
    if (!box) return;
    if (!wind) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    var html = '';
    for (var k = 0; k < 16; k++) html += '<span class="wx-p-wind" style="top:' + (Math.random() * 100).toFixed(1) + '%;animation-delay:-' + (Math.random() * 3).toFixed(2) + 's;animation-duration:' + (1.6 + Math.random() * 2).toFixed(2) + 's"></span>';
    box.innerHTML = html;
  }

  // Капли дождя / снежинки — строго ВНУТРИ квадратов с дождём/снегом (крупные, видимые).
  // Только видимые квадраты и при зуме >= 11 (иначе ячейки слишком мелкие).
  function renderWxCellParticles(rain, snow) {
    if (!WXM || !WXM.map || !WXM.dropGroup) return;
    WXM.dropGroup.clearLayers();
    if ((!rain && !snow) || WXM.map.getZoom() < 11) return;
    var map = WXM.map, h = WXM.hour, view = map.getBounds();
    WXM.cellLayers.forEach(function (cl) {
      var rec = WXM.fetchData[cl.fi] ? WXM.fetchData[cl.fi][h] : null;
      if (!rec) return;
      var type = (rain && rec.rain > 0) ? 'rain' : ((snow && rec.snow > 0) ? 'snow' : null);
      if (!type) return;
      var b = cl.rect.getBounds();
      if (!view.intersects(b)) return;            // только квадраты в видимой области
      var nw = map.latLngToContainerPoint(b.getNorthWest());
      var se = map.latLngToContainerPoint(b.getSouthEast());
      var w = Math.max(6, Math.abs(se.x - nw.x)), hh = Math.max(6, Math.abs(se.y - nw.y));
      var n = 2;
      var html = '<div class="wx-cdrop wx-cdrop-' + type + '">';
      for (var i = 0; i < n; i++) {
        if (type === 'rain') {
          html += '<span class="wx-drop" style="left:' + Math.round(Math.random() * 100) + '%;animation-delay:-' + (Math.random() * 0.8).toFixed(2) + 's;animation-duration:' + (0.5 + Math.random() * 0.4).toFixed(2) + 's"></span>';
        } else {
          html += '<span class="wx-flake" style="left:' + Math.round(Math.random() * 100) + '%;animation-delay:-' + (Math.random() * 3).toFixed(2) + 's;animation-duration:' + (2 + Math.random() * 2).toFixed(2) + 's"></span>';
        }
      }
      html += '</div>';
      WXM.dropGroup.addLayer(window.L.marker(b.getCenter(), { icon: window.L.divIcon({ html: html, className: '', iconSize: [w, hh], iconAnchor: [w / 2, hh / 2] }), interactive: false, keyboard: false, zIndexOffset: 550 }));
    });
  }

  function wxValRow(ic, val, col) {
    return '<span class="wx-cl-row" style="color:' + col + '">' + ic + val + '</span>';
  }
  function renderDashboard() {
    // Для админа: фильтр по участку (null = все участки)
    var dashFilterArea = S.dashArea;
    function dashMasters() {
      // Админ и начальник участка на дашборде видят ВСЕ участки (с возможностью выбора); прочие — свой
      var all = (S.role === 'admin' || S.role === 'nach') ? getMasters() : visibleMasters();
      if ((S.role === 'admin' || S.role === 'nach') && dashFilterArea) return all.filter(function (m) { return m.area === dashFilterArea; });
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
    var overloads = mastersToday.filter(function (m) { return loadForDay(m.id, 0) > dayCapacity(0); }).length;
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

    // === Селектор участка для админа и начальника участка ===
    if (S.role === 'admin' || S.role === 'nach') {
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
    html += kpi(today.length, 'Задач на сегодня', 'по ' + mastersToday.length + ' мастера(ам)', '#2563eb', 'kpi-today');
    html += kpi(overloads, 'Перегрузок сегодня', 'превышение ФРВ ' + fmtH(dayCapacity(0)) + ' ч', '#dc2626', 'kpi-overloads');
    html += kpi(pct + '%', 'Выполнено за месяц', doneMonth + ' из ' + totalMonth + ' работ', '#16a34a', 'kpi-month');
    // KPI УБиРОГС
    var permitCount = vt.filter(function(t) { return t.needs_permit && !isDone(t); }).length;
    var weatherCount = vt.filter(function(t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; }).length;
    html += kpi(permitCount, 'Ордеров истекает', 'работы с разрешениями', '#f59e0b', 'kpi-permits');
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
    if (!todayWeather) {
      todayWeather = { temp: '—', desc: 'Загрузка...', snow: false, snowfall: 0 };
    }
    var snowExpected = '';
    for (var off = 1; off <= 7; off++) {
      var wf = getWeatherForecast(off);
      if (wf && wf.snow && wf.snowfall > 0.1) {
        snowExpected = ' · ❄️ Снег ожидается ' + fmtShort(off) + ' (' + wf.snowfall + ' мм)';
        break;
      }
    }
    var wIcon = todayWeather.snow ? '❄️' : todayWeather.desc.indexOf('Дождь') !== -1 || todayWeather.desc.indexOf('Морось') !== -1 ? '🌧️' : todayWeather.desc === 'Ясно' ? '☀️' : '⛅';
    var _wx = weatherSceneHTML(todayWeather);
    html += '<div data-action="open-weather" style="margin-bottom:0;padding:14px 18px;min-height:68px;background:linear-gradient(to right,#1e3a5f 0%,#2563eb 30%,rgba(37,99,235,0) 62%);color:#fff;border-radius:10px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:transform .2s,box-shadow .2s;position:relative;overflow:hidden;" onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 8px 24px rgba(0,0,0,.3)\';" onmouseout="this.style.transform=\'\';this.style.boxShadow=\'\';" title="Нажмите для просмотра прогноза на 15 дней">';
    html += _wx.html;
    html += '<span style="font-size:28px;position:relative;z-index:1;text-shadow:0 1px 5px rgba(0,0,0,.35);">' + wIcon + '</span>';
    html += '<div style="position:relative;z-index:1;text-shadow:0 1px 5px rgba(0,0,0,.35);"><div style="font-size:15px;font-weight:700;">' + todayWeather.temp + '°C · ' + todayWeather.desc + '</div>';
    html += '<div style="font-size:11px;color:#e2e8f0;">Погода: Минск · ' + fmt(TODAY) + snowExpected + '</div></div>';
    html += '<button class="wx-map-fab" data-action="open-wx-map" title="Открыть карту погоды Минска и Минской области">🗺 Карта погоды</button>';
    html += '</div>';
    // Выпадающий список при нажатии
    html += '<div id="weather-dropdown" class="weather-dropdown"></div>';
    // Отступ перед панелью аналитики
    html += '<div style="height:16px;"></div>';

    // === Панель аналитики (админ / начальник / ст.мастер / Начальник СЭОГС) ===
    if (canPlan() || S.role === 'viewer') {
      var dMY = getDashMY();
      var dmTasks = vt.filter(function(t) { var dd = offToDate(t.d); return dd.getMonth() === dMY.m && dd.getFullYear() === dMY.y; });
      var aWorkH = 0, aTravelMin = 0, aTravelCnt = 0;
      dmTasks.forEach(function(t) {
        aWorkH += taskHours(t);
        var tmin = taskTravelMin(t);
        if (tmin <= 0) tmin = estimateTravelMin(t);   // нет расчёта маршрута — оценка по расстоянию
        if (tmin > 0) { aTravelMin += tmin; aTravelCnt++; }
      });
      var aTravelH = aTravelMin / 60;
      var aTotalH = aWorkH + aTravelH;
      var aPctObj = aTotalH > 0 ? (aWorkH / aTotalH * 100) : 0;
      var aPctRoad = aTotalH > 0 ? (aTravelH / aTotalH * 100) : 0;
      var aAvgTravel = aTravelCnt > 0 ? Math.round(aTravelMin / aTravelCnt) : 0;
      var dmRed = dmTasks.filter(function(t) { return !isDone(t) && (t.dl <= 2 || t.d < 0); });
      var dmOverdue = dmTasks.filter(function(t) { return !isDone(t) && (t.dl < 0 || t.d < 0); });
      var dmWorkDays = countWorkDays(dMY.y, dMY.m);
      var dmCapacity = 0;
      for (var _d = 1, _dim = new Date(dMY.y, dMY.m + 1, 0).getDate(); _d <= _dim; _d++) {
        dmCapacity += dayCapacity(dateToOff(new Date(dMY.y, dMY.m, _d)));
      }
      dmCapacity *= Math.max(1, dashMasters().length);
      var dmReserve = dmCapacity - aWorkH;
      var hasOverdue = dmOverdue.length > 0;
      var dec = function(x) { return (Math.round(x * 10) / 10).toString().replace('.', ','); };
      var sgn = function(x) { return (x >= 0 ? '+' : '') + fmtH(x); };
      var reserveColor = dmReserve >= 0 ? '#4ade80' : '#f87171';
      var statusColor = hasOverdue ? '#f87171' : '#4ade80';
      var statusTxt = hasOverdue ? '\u26a0 Риск просрочки есть' : '\u2713 Риска просрочки нет';

      html += '<div class="card" style="margin-bottom:16px;background:linear-gradient(135deg, #0f2740 0%, #1a3a5c 100%);color:#fff;border:1px solid rgba(255,255,255,0.15);">';
      html += '<div class="card-h" style="border-bottom:1px solid rgba(255,255,255,0.12);position:relative;"><h2 style="color:#fff;display:flex;align-items:center;gap:8px;">\ud83d\udcca Панель аналитики</h2><span class="sub" style="color:#94a3b8;">Аналитика за месяц</span><div class="spacer"></div><button type="button" data-action="dash-month-toggle" title="Выбрать месяц для расчёта" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;font-weight:700;font-family:inherit;border-radius:9px;padding:6px 14px;cursor:pointer;font-size:13px;">\ud83d\udcc5 <span id="dash-month-label">' + dashMonthLabel() + '</span></button><span style="background:none;color:#fff;font-weight:700;">SmartPlanner Ядро 2.0</span></div>';
      html += '<div class="card-b" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:16px;padding:16px;">';
      // КПД мастеров
      html += '<div style="background:rgba(255,255,255,0.06);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;font-weight:600;">\u26a1 КПД Мастеров (Работа vs Дорога)</div><div style="font-size:22px;font-weight:800;color:#38bdf8;margin-bottom:4px;">' + (aTotalH > 0 ? dec(aPctObj) : '\u2014') + '% <span style="font-size:13px;font-weight:500;color:#94a3b8;">на объектах</span></div><div style="font-size:11.5px;color:#cbd5e1;">\ud83d\ude97 В пути: <b>' + (aTotalH > 0 ? dec(aPctRoad) : '0') + '%</b> \u00b7 На объектах: <b>' + dec(aPctObj) + '%</b><br>Всего в пути за месяц: <b>' + fmtH(aTravelH) + ' ч</b> \u00b7 Среднее время переезда: <b>\u2248 ' + aAvgTravel + ' мин</b></div></div>';
      // Сводка по дедлайнам
      html += '<div style="background:rgba(255,255,255,0.06);padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);"><div style="font-size:11px;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;font-weight:600;">\u23f0 Сводка по дедлайнам (\u2264 3 дня)</div><div style="font-size:22px;font-weight:800;color:#facc15;margin-bottom:4px;">' + dmRed.length + ' <span style="font-size:13px;font-weight:500;color:#94a3b8;">задач в зоне</span></div><div style="font-size:11.5px;color:#cbd5e1;">Резерв ресурса: <b style="color:' + reserveColor + ';">' + sgn(dmReserve) + ' чел/ч</b><br>Статус: <b style="color:' + statusColor + ';">' + statusTxt + '</b></div></div>';
      html += '</div></div>';
    }

    html += '<div class="dash-grid">';
    html += '<div class="card"><div class="card-h"><h2>Сегодня</h2><span class="sub">' + fmt(TODAY) + '</span><div class="spacer"></div><span class="badge tag ' + (overloads ? 'over' : 'ok') + '">' + (overloads ? 'Есть перегрузки' : 'Без перегрузок') + '</span></div><div class="card-b">';
    if (!today.length) html += '<div class="empty">На сегодня задач нет</div>';
    mastersToday.forEach(function (m) {
      var mt = today.filter(function (t) { return t.m === m.id; });
      var load = mt.reduce(function (s, t) { return s + (isDone(t) ? 0 : taskHours(t)); }, 0);
      var over = load > dayCapacity(0);
      html += '<div class="today-mstr"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div><div class="meta"><div class="h" style="color:' + (over ? 'var(--red)' : 'var(--ink)') + '">' + fmtH(load) + ' ч / ' + fmtH(dayCapacity(0)) + ' ч</div><span class="tag ' + (over ? 'over' : 'ok') + '">' + (over ? '⚠ Перегрузка +' + fmtH(load - dayCapacity(0)) + ' ч' : mt.length + ' заданий') + '</span></div></div>';
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

    view.innerHTML = html;
    document.getElementById('rz-badge').textContent = redzone.length;

    // привязка селектора участка (для админа)
    var dashAreaSel = document.getElementById('dash-area');
    if (dashAreaSel) dashAreaSel.addEventListener('change', function (e) { S.dashArea = e.target.value || null; renderDashboard(); });
    // Запуск случайных вспышек молний, если сегодня гроза (сцена содержит #wx-bolts)
    setupLightning();
  }

  function kpi(val, lab, hint, color, action) {
    var clickAttr = action ? ' data-action="' + action + '" style="cursor:pointer"' : '';
    return '<div class="kpi"' + clickAttr + '><div class="acc" style="background:' + color + '"></div><div class="lab">' + lab + '</div><div class="val">' + val + '</div><div class="hint">' + hint + '</div></div>';
  }

  // Мягкое обновление KPI на дашборде — только числа, без перестройки DOM
  function softUpdateDashboard() {
    var vt = visibleTasks();
    var mastersToday = visibleMasters();
    var today = vt.filter(function (t) { return t.d === 0; });
    var overloads = mastersToday.filter(function (m) { return loadForDay(m.id, 0) > dayCapacity(0); }).length;
    var permitCount = vt.filter(function(t) { return t.needs_permit && !isDone(t); }).length;

    // Обновляем только значения внутри существующих KPI карточек
    var kpiEls = document.querySelectorAll('.kpi .val');
    if (kpiEls.length >= 4) {
      if (kpiEls[0]) kpiEls[0].textContent = today.length;
      if (kpiEls[1]) kpiEls[1].textContent = overloads;
      // KPI 3 — процент выполнения
      var doneMonth = 0, totalMonth = 0;
      vt.forEach(function (t) {
        var d = offToDate(t.d);
        if (d.getMonth() === TODAY.getMonth() && d.getFullYear() === TODAY.getFullYear()) { totalMonth++; if (isDone(t)) doneMonth++; }
      });
      var pct = totalMonth ? Math.round(doneMonth / totalMonth * 100) : 0;
      if (kpiEls[2]) kpiEls[2].textContent = pct + '%';
      if (kpiEls[3]) kpiEls[3].textContent = permitCount;
    }
  }
  function ringHTML(pct, size, stroke, small) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    var col = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    var fs = small ? 13 : 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="#e2e8f0" stroke-width="' + stroke + '"/><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')"/><text x="50%" y="54%" text-anchor="middle" font-size="' + fs + '" font-weight="800" fill="#1f2937">' + pct + '%</text></svg>';
  }

  /* =====================================================================
     ПОПАП-КАЛЕНДАРЬ (выбор даты в планировании)
     ===================================================================== */
  var dpState = { viewMonth: new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), selectedDate: null };

  function openDatePicker(anchorEl) {
    var popup = document.getElementById('date-popup');
    if (!popup) return;

    // Позиционируем попап относительно заголовка
    var rect = anchorEl.getBoundingClientRect();
    popup.style.left = Math.min(rect.left, window.innerWidth - 340) + 'px';
    popup.style.top = (rect.bottom + 8) + 'px';

    dpState.viewMonth = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    var shift = (S.calMode === 'week') ? S.weekShift : (S.calMode === 'month' ? S.monthShift : S.dayShift);
    if (S.calMode === 'week') dpState.viewMonth = addDays(mondayOf(TODAY), shift * 7);
    if (S.calMode === 'month') dpState.viewMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + shift, 1);
    if (S.calMode === 'day') dpState.viewMonth = addDays(TODAY, shift);

    renderDatePicker();
    popup.classList.add('open');

    // Закрытие по клику вне попапа
    setTimeout(function() {
      document.addEventListener('click', closeDatePickerOutside);
    }, 100);
  }

  function closeDatePickerOutside(e) {
    var popup = document.getElementById('date-popup');
    if (!popup || !popup.classList.contains('open')) return;
    if (!popup.contains(e.target) && !e.target.closest('#cal-title')) {
      closeDatePicker();
    }
  }

  function closeDatePicker() {
    var popup = document.getElementById('date-popup');
    if (popup) popup.classList.remove('open');
    document.removeEventListener('click', closeDatePickerOutside);
  }

  function renderDatePicker() {
    var m = dpState.viewMonth.getMonth();
    var y = dpState.viewMonth.getFullYear();
    var monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    document.getElementById('dp-month-year').textContent = monthNames[m] + ' ' + y;

    var grid = document.getElementById('dp-grid');
    var html = '';
    var wds = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    wds.forEach(function(wd) { html += '<div class="dp-wd">' + wd + '</div>'; });

    var firstDay = new Date(y, m, 1);
    var lastDay = new Date(y, m + 1, 0);
    var startOffset = (firstDay.getDay() + 6) % 7;

    // Дни предыдущего месяца
    for (var i = startOffset - 1; i >= 0; i--) {
      var d = new Date(y, m, -i);
      html += '<button class="dp-day other-month" data-date="' + key(d) + '">' + d.getDate() + '</button>';
    }

    // Текущий месяц
    for (var day = 1; day <= lastDay.getDate(); day++) {
      var d = new Date(y, m, day);
      var cls = 'dp-day';
      if (sameDay(d, TODAY)) cls += ' today';
      html += '<button class="' + cls + '" data-date="' + key(d) + '">' + day + '</button>';
    }

    // Дни следующего месяца
    var totalCells = startOffset + lastDay.getDate();
    var remaining = (7 - (totalCells % 7)) % 7;
    for (var j = 1; j <= remaining; j++) {
      var d = new Date(y, m + 1, j);
      html += '<button class="dp-day other-month" data-date="' + key(d) + '">' + j + '</button>';
    }

    grid.innerHTML = html;

    // Привязка кликов по дням
    grid.querySelectorAll('.dp-day').forEach(function(btn) {
      btn.addEventListener('click', function() {
        grid.querySelectorAll('.dp-day.selected').forEach(function(b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        dpState.selectedDate = btn.dataset.date;
      });
    });
  }

  function applyDatePicker() {
    if (!dpState.selectedDate) { closeDatePicker(); return; }
    var picked = new Date(dpState.selectedDate + 'T00:00:00');
    var off = dateToOff(picked);

    if (S.calMode === 'day') S.dayShift = off;
    else if (S.calMode === 'week') S.weekShift = Math.floor(off / 7);
    else if (S.calMode === 'month') S.monthShift = (picked.getFullYear() - TODAY.getFullYear()) * 12 + (picked.getMonth() - TODAY.getMonth());

    closeDatePicker();
    renderCalendar();
  }

  function initDatePicker() {
    var prev = document.getElementById('dp-prev');
    var next = document.getElementById('dp-next');
    var todayBtn = document.getElementById('dp-today');
    var cancelBtn = document.getElementById('dp-cancel');
    var applyBtn = document.getElementById('dp-apply');

    if (prev) prev.addEventListener('click', function() {
      dpState.viewMonth = new Date(dpState.viewMonth.getFullYear(), dpState.viewMonth.getMonth() - 1, 1);
      renderDatePicker();
    });
    if (next) next.addEventListener('click', function() {
      dpState.viewMonth = new Date(dpState.viewMonth.getFullYear(), dpState.viewMonth.getMonth() + 1, 1);
      renderDatePicker();
    });
    if (todayBtn) todayBtn.addEventListener('click', function() {
      dpState.viewMonth = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
      renderDatePicker();
    });
    if (cancelBtn) cancelBtn.addEventListener('click', closeDatePicker);
    if (applyBtn) applyBtn.addEventListener('click', applyDatePicker);
  }

  /* =====================================================================
     КОРЗИНА (синхронизированная через сервер)
     ===================================================================== */
  var TRASH_KEY = 'smartplan_trash';

  function getTrash() {
    try { var raw = localStorage.getItem(TRASH_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
    return [];
  }

  function saveTrash(arr) {
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  // Загрузка корзины с сервера
  function loadTrashFromServer() {
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    if (!API || !DB.isServerOnline()) return Promise.resolve(getTrash());
    return fetch(API + '/api/trash')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.tasks) {
          var trash = data.tasks.map(function(t) {
            return Object.assign({}, t, { _deletedAt: t.created || Date.now() });
          });
          saveTrash(trash);
          return trash;
        }
        return getTrash();
      })
      .catch(function() { return getTrash(); });
  }

  function addToTrash(task) {
    var trash = getTrash();
    task._deletedAt = Date.now();
    trash.push(task);
    // Оставляем только задачи за последние 14 дней
    var cutoff = Date.now() - 14 * 86400000;
    trash = trash.filter(function(t) { return t._deletedAt > cutoff; });
    saveTrash(trash);
    // Отправляем на сервер — мягкое удаление
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    if (API && DB.isServerOnline()) {
      fetch(API + '/api/tasks/' + task.id, { method: 'DELETE' }).catch(function() {});
    }
  }

  function restoreFromTrash(trashIdx) {
    var trash = getTrash();
    if (trashIdx < 0 || trashIdx >= trash.length) return;
    var task = trash[trashIdx];
    trash.splice(trashIdx, 1);
    saveTrash(trash);

    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';

    // Сначала восстанавливаем на сервере, потом обновляем всё
    var restorePromise;
    if (API && DB.isServerOnline()) {
      restorePromise = fetch(API + '/api/trash/restore/' + task.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'plan', s: 'plan', addr: task.addr || '', m: task.m || '', d: task.d || 0, dl: task.dl || 7, volume: task.volume || 1 })
      }).catch(function() {});
    } else {
      // Автономный режим — добавляем локально
      task.s = 'plan'; task.status = 'plan';
      delete task._deletedAt;
      if (TASKS_DB) { TASKS_DB.addTask(task); S.tasks = TASKS_DB.getTasks(); }
      restorePromise = Promise.resolve();
    }

    restorePromise.then(function() {
      // Полное обновление данных с сервера
      if (DB.isServerOnline()) {
        DB.syncFromServer().then(function() {
          if (window.SP_TASKS) S.tasks = window.SP_TASKS.getTasks();
          drawCalendarGrid();
          openTrashModal();
        });
      } else {
        drawCalendarGrid();
        openTrashModal();
      }
    });
    toast('ok', '✅ Задача восстановлена из корзины');
  }

  function purgeTrash() {
    var oldTrash = getTrash();
    saveTrash([]);
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    var purgePromises = [];
    if (API && DB.isServerOnline()) {
      oldTrash.forEach(function(t) {
        if (t.id) {
          purgePromises.push(fetch(API + '/api/trash/' + t.id, { method: 'DELETE' }).catch(function() {}));
        }
      });
    }
    // Ждём удаления с сервера, потом обновляем всё
    Promise.all(purgePromises).then(function() {
      if (DB.isServerOnline()) {
        DB.syncFromServer().then(function() {
          if (window.SP_TASKS) S.tasks = window.SP_TASKS.getTasks();
          drawCalendarGrid();
          openTrashModal();
        });
      } else {
        drawCalendarGrid();
        openTrashModal();
      }
    });
    toast('ok', '🗑 Корзина очищена');
  }

  function openTrashModal() {
    // Показываем загрузку
    modal.innerHTML = '<div class="modal-h"><h3>🗑 Корзина</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b"><div class="empty" style="padding:40px 20px;">Загрузка...</div></div>';
    overlay.classList.add('show');

    // Загружаем актуальную корзину с сервера
    loadTrashFromServer().then(function(trash) {
      trash.sort(function(a, b) { return (b._deletedAt || 0) - (a._deletedAt || 0); });
      var html = '<div class="modal-h"><h3>🗑 Корзина</h3><button class="x" data-action="close-modal">×</button></div>';
      html += '<div class="modal-b">';
      if (!trash.length) {
        html += '<div class="empty" style="padding:40px 20px;">Корзина пуста<br><span style="font-size:12px;">Удалённые задачи хранятся 14 дней</span></div>';
      } else {
        html += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Задач в корзине: ' + trash.length + ' · хранятся 14 дней · синхронизировано</div>';
        trash.forEach(function(t, idx) {
          var w = WORK.getWork('УБиРОГС', t.w) || WORK_MAP[t.w];
          var deletedDate = parseLogDate(t._deletedAt);
          var delStr = deletedDate ? deletedDate.getDate() + ' ' + MON[deletedDate.getMonth()] : '—';
          var daysAgo = deletedDate ? Math.floor((Date.now() - deletedDate.getTime()) / 86400000) : -1;
          html += '<div class="rz-item"><div class="rz-bar" style="background:var(--muted);"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : 'Задача') + ' — ' + esc(t.addr || addrOf(t)) + '</div><div class="rz-s">Удалено: ' + delStr + ' · ' + (daysAgo < 0 ? 'недавно' : daysAgo === 0 ? 'сегодня' : daysAgo + ' дн назад') + ' · Объём: ' + (t.volume || 1) + '</div></div>' + (canPlan() ? '<button class="btn sm" data-action="restore-task" data-trash-idx="' + idx + '" style="color:var(--green);white-space:nowrap;">↩ Восстановить</button>' : '<span style="font-size:11px;color:var(--muted)">только просмотр</span>') + '</div>';
        });
        if (canPlan()) html += '<div style="margin-top:16px;text-align:right;"><button class="btn sm" data-action="purge-trash" style="color:var(--red);">Очистить корзину полностью</button></div>';
      }
      html += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Закрыть</button></div>';
      modal.innerHTML = html;
    });
  }

  /* =====================================================================
     РЕНДЕР: КАЛЕНДАРЬ
     ===================================================================== */
  function renderCalendar() {
    var html = '<div class="cal-head"><div class="seg">';
    html += segBtn('day', 'День') + segBtn('week', 'Неделя') + segBtn('month', 'Месяц');
    html += '</div>';
    html += '<button class="btn sm" data-action="cal-prev">‹</button>';
    html += '<span class="cal-title" id="cal-title" style="cursor:pointer;padding:4px 12px;border-radius:8px;transition:.15s;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px;" onmouseover="this.style.background=\'#eff6ff\';this.style.textDecorationColor=\'#2563eb\'" onmouseout="this.style.background=\'transparent\';this.style.textDecorationColor=\'transparent\'" title="Нажмите для выбора даты"></span>';
    html += '<button class="btn sm" data-action="cal-next">›</button>';
    if (S.calMode !== 'day' || S.dayShift !== 0) html += '<button class="btn sm" data-action="cal-today">Сегодня</button>';
    if (canPlan()) {
      html += '<button class="btn sm primary" data-action="new-task">' + IC.plus + ' Добавить задачу</button>';
      html += '<button class="btn sm" data-action="optimize-works" style="background:#6366f1;color:#fff;border-color:#6366f1;" title="Автоматическое распределение работ без просрочек с соблюдением 8-часового рабочего дня">⚡ Оптимизировать работы</button>';
      html += '<button class="btn sm" data-action="import-tasks-excel" style="background:#10b981;color:#fff;border-color:#10b981;" title="Импорт задач из Excel с валидацией">📥 Импорт из Excel</button>';
    }
    html += '<div class="trash-zone" id="trash-zone" data-action="open-trash" title="Перетащите задачу для удаления или нажмите для просмотра удалённых" style="cursor:pointer;">' + IC.trash + ' <span>Корзина</span></div>';
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
  var _drawGridTm = null;
  function drawCalendarGrid() {
    if (_drawGridTm) clearTimeout(_drawGridTm);
    _drawGridTm = setTimeout(_drawCalendarGridImpl, 50);
  }
  function _drawCalendarGridImpl() {
    var grid = document.getElementById('cal-grid');
    var masters = visibleMasters();
    var days = buildDayWindow();
    var titleEl = document.getElementById('cal-title');
    if (titleEl) {
      titleEl.textContent = windowTitle(days);
      // Привязка открытия календаря
      titleEl.onclick = function() { openDatePicker(titleEl); };
    }

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
        var acKey = m.id + '_' + off;
        // Фоновый расчёт маршрута для ячейки — запускаем ДО отрисовки,
        // чтобы успеть выставить статус 'loading' и показать «🚗 расчёт…»
        var dayTasks = S.tasks.filter(function(t) { return t.m === m.id && t.d === off && !isDone(t); });
        if (dayTasks.length >= 1 && !autoRouteCache[acKey]) autoCalcRoute(m.id, off, dayTasks);
        var _cellRT = getRouteTime(m.id, off);
        var _cellAC = autoRouteCache[acKey];
        var cellLegs = (_cellAC && _cellAC.legs) ? _cellAC.legs : (_cellRT && _cellRT.legs ? _cellRT.legs : null);
        var load = loadForDay(m.id, off);
        var over = load > dayCapacity(off);
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
            var permitLine = '';
            if (t.needs_permit) {
              permitLine = '<span class="tile-permit">📋 Ордер до: ' + (t.dl_date || '—') + '</span>';
            } else if (wMeta && wMeta.min_temp > -50) {
              var wf = getWeatherForecast(off);
              if (wf && wf.temp != null && wf.temp < wMeta.min_temp) badges += '<span class="ov-weather">⚠</span>';
            }
            var legInfo = cellLegs ? cellLegs[t.id] : null;
            if (!legInfo && t.travelMin != null && t.travelKm != null) legInfo = { min: t.travelMin, km: t.travelKm };
            // Есть ли координаты у задачи (иначе адрес не найден картой)
            var _hasCoords = (t.lat != null && t.lng != null);
            if (!_hasCoords && t.o) { var _o = OBJ_MAP[t.o]; if (_o && _o.lat && _o.lng) _hasCoords = true; }
            if (!_hasCoords && t.addr) { var _gc = getTaskCoords(t.addr); if (_gc) _hasCoords = true; }
            var tileLegHtml;
            if (legInfo) {
              tileLegHtml = '<span class="tile-leg" style="display:block;font-size:10px;color:#2563eb;font-weight:600;margin-top:2px;white-space:nowrap;">🚗 ' + fmtDuration(legInfo.min) + ' · ' + (legInfo.km || 0).toFixed(1).replace('.', ',') + ' км</span>';
            } else if (!_hasCoords) {
              tileLegHtml = '<span class="tile-leg" style="display:block;font-size:10px;color:#dc2626;font-weight:600;margin-top:2px;white-space:nowrap;">⚠ Адрес не найден</span>';
            } else {
              tileLegHtml = '';
            }
            html += '<div class="tile t-' + col + '" draggable="' + draggable + '" data-action="edit-task" data-tid="' + t.id + '" title="Нажмите для редактирования задания">' + badges + '<span class="tw">' + esc(w ? w.name : '?') + (t.volume ? ' ×' + t.volume : '') + '</span><span class="th">' + esc(addrOf(t)) + ' · ' + fmtH(taskHours(t)) + 'ч</span>' + permitLine + tileLegHtml + '<label class="tile-chk" onmousedown="event.stopPropagation()" ondragstart="return false"><input type="checkbox" data-action="toggle-done" data-tid="' + t.id + '"' + (isDone(t) ? ' checked' : '') + (S.role === 'viewer' ? ' disabled' : '') + '><span class="tile-chk-box"></span></label></div>';
          }
        });
        // Время в пути — итог по дню (расчёт уже запущен в начале ячейки)
        var rtInfo = _cellRT;
        var acStatus = _cellAC ? _cellAC.status : null;
        if (rtInfo && dayTasks.length >= 1) {
          html += '<div class="cell-route" title="Время в пути по маршруту">🚗 ' + fmtDuration(rtInfo.minutes) + ' · ' + (rtInfo.km || 0).toFixed(1).replace('.', ',') + ' км</div>';
        } else if (acStatus === 'loading') {
          html += '<div class="cell-route" style="color:#94a3b8">🚗 расчёт...</div>';
        }
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
    return MON_NOM[days[0].getMonth()] + ' ' + days[0].getFullYear();
  }

  /* ---------- DRAG & DROP ---------- */
  var dragId = null;
  /* === Общие функции переноса задач (используются DnD и touch) === */
  function moveTaskToCell(id, cell) {
    var t = findTask(id); if (!t) return;
    if (!canEditTask(t)) { toast('err', 'Нет прав на редактирование этой задачи'); return; }
    var newMaster = cell.dataset.master, newOff = parseInt(cell.dataset.off, 10);
    var oldM = t.m, oldOff = t.d;
    if (!canDropOn(newMaster)) { toast('err', 'Этот мастер вне вашего доступа'); return; }
    var target = masterById(newMaster);
    var moved = [];
    if (t.m !== newMaster) { t.m = newMaster; moved.push('мастер → ' + (target ? target.name : '?')); }
    if (t.d !== newOff) { t.d = newOff; moved.push('дата → ' + fmtShort(newOff)); }
    if (moved.length) {
      if (TASKS_DB) { TASKS_DB.updateTask(t.id, t); }
      invalidateRouteCache(oldM, oldOff);
      invalidateRouteCache(newMaster, newOff);
      logAction('Перемещение задачи', (target ? target.name : '?') + ': ' + moved.join(', '));
      drawCalendarGrid();
      var load = loadForDay(newMaster, newOff);
      if (load > dayCapacity(newOff)) {
        toast('warn', '🛑 Аналитика помощника : Внимание! Перегрузка мастера ' + (target ? target.name : '') + ' до ' + fmtH(load) + ' ч (при норме ' + fmtH(dayCapacity(newOff)) + ' ч). Предлагаем перенести задачу на другой день или заменить мастера!');
      } else {
        toast('ok', '💡 Аналитика помощника : Перенос успешно выполнен. Текущая загрузка мастера ' + (target ? target.name : '') + ' на этот день составляет ' + fmtH(load) + ' ч / ' + fmtH(dayCapacity(newOff)) + ' ч.');
      }
    }
  }

  function deleteTaskToTrash(id) {
    var t = findTask(id); if (!t) return;
    if (!canEditTask(t)) { toast('err', 'Нет прав на удаление этой задачи'); return; }
    var w = workOf(t);
    if (!window.confirm('Удалить задачу «' + (w ? w.name : '?') + ' — ' + addrOf(t) + '»?')) return;
    addToTrash(JSON.parse(JSON.stringify(t)));
    if (TASKS_DB) { TASKS_DB.deleteTask(id); S.tasks = TASKS_DB.getTasks(); } else { S.tasks = S.tasks.filter(function (x) { return x.id !== id; }); }
    invalidateRouteCache(t.m, t.d);
    drawCalendarGrid();
    logAction('Удаление задачи', (w ? w.name : '?') + ' — ' + addrOf(t));
        toast('ok', '🗑️ Аналитика помощника : Задача удалена. Освободилось ' + fmtH(taskHours(t)) + ' ч у мастера ' + (masterById(t.m) ? masterById(t.m).name : '?') + '.');
  }

  function reorderMapCard(fromId, toId) {
    var pts = ymState.pts;
    if (!pts || !pts.length) return;
    var fromIdx = -1, toIdx = -1;
    pts.forEach(function (p, i) {
      if (p.id === fromId) fromIdx = i;
      if (p.id === toId) toIdx = i;
    });
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    var moved = pts.splice(fromIdx, 1)[0];
    pts.splice(toIdx, 0, moved);
    ymState.manualOrder = true;
    refreshMapCards(pts);
    drawMap(pts);
    toast('ok', 'Порядок изменён');
  }

  /* === Touch Drag & Drop Polyfill (для планшетов и телефонов) === */
  function enableTouchDnD() {
    var ts = null; // touchState

    function onStart(e) {
      var tile = e.target.closest('.tile[draggable="true"]');
      var mtask = e.target.closest('.mtask[draggable="true"]');
      var el = tile || mtask;
      if (!el) return;
      // Не мешаем кликам по чекбоксам, кнопкам и grip-иконкам
      if (e.target.closest('.tile-chk') || e.target.closest('button') || e.target.tagName === 'INPUT') return;
      var touch = e.touches[0];
      ts = {
        type: tile ? 'tile' : 'mtask',
        id: tile ? tile.dataset.tid : mtask.dataset.mid,
        startX: touch.clientX, startY: touch.clientY,
        moved: false, el: el, ghost: null, dropTarget: null, dropType: null
      };
    }

    function onMove(e) {
      if (!ts) return;
      var touch = e.touches[0];
      if (!ts.moved) {
        if (Math.abs(touch.clientX - ts.startX) < 8 && Math.abs(touch.clientY - ts.startY) < 8) return;
        ts.moved = true;
        // Создаём ghost-клон
        var rect = ts.el.getBoundingClientRect();
        ts.ghost = ts.el.cloneNode(true);
        ts.ghost.style.cssText = 'position:fixed;z-index:99999;opacity:0.85;pointer-events:none;width:' + rect.width + 'px;transform:scale(0.92) rotate(-1deg);box-shadow:0 8px 24px rgba(0,0,0,.3);';
        document.body.appendChild(ts.ghost);
        ts.el.style.opacity = '0.25';
      }
      if (ts.moved) {
        e.preventDefault();
        var g = ts.ghost;
        g.style.left = (touch.clientX - g.offsetWidth / 2) + 'px';
        g.style.top = (touch.clientY - 25) + 'px';
        // Найти элемент под пальцем (скрываем ghost на мгновение)
        g.style.display = 'none';
        var under = document.elementFromPoint(touch.clientX, touch.clientY);
        g.style.display = '';

        // Очистка старой подсветки
        document.querySelectorAll('.cell.drop-on').forEach(function (c) { c.classList.remove('drop-on'); });
        document.querySelectorAll('.mtask.drop-above').forEach(function (c) { c.classList.remove('drop-above'); });
        var tr = document.getElementById('trash-zone');
        if (tr) tr.classList.remove('drop-active');

        ts.dropType = null; ts.dropTarget = null;

        if (ts.type === 'tile') {
          var cell = under ? under.closest('.cell') : null;
          var trash = under ? under.closest('.trash-zone') : null;
          if (cell) { cell.classList.add('drop-on'); ts.dropType = 'cell'; ts.dropTarget = cell; }
          else if (trash) { trash.classList.add('drop-active'); ts.dropType = 'trash'; ts.dropTarget = trash; }
        } else if (ts.type === 'mtask') {
          var card = under ? under.closest('.mtask') : null;
          if (card && card.dataset.mid !== ts.id) { card.classList.add('drop-above'); ts.dropType = 'mtask'; ts.dropTarget = card; }
        }
      }
    }

    function onEnd(e) {
      if (!ts) return;
      if (ts.ghost) ts.ghost.remove();
      if (ts.el) ts.el.style.opacity = '';
      document.querySelectorAll('.cell.drop-on').forEach(function (c) { c.classList.remove('drop-on'); });
      document.querySelectorAll('.mtask.drop-above').forEach(function (c) { c.classList.remove('drop-above'); });
      var tr = document.getElementById('trash-zone');
      if (tr) tr.classList.remove('drop-active');

      if (ts.moved && ts.dropType && ts.dropTarget) {
        if (ts.dropType === 'cell') moveTaskToCell(ts.id, ts.dropTarget);
        else if (ts.dropType === 'trash') deleteTaskToTrash(ts.id);
        else if (ts.dropType === 'mtask') reorderMapCard(ts.id, ts.dropTarget.dataset.mid);
      }
      ts = null;
    }

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
  }

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
      cell.classList.remove('drop-on');
      var id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      moveTaskToCell(id, cell);
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
        deleteTaskToTrash(dragId);
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
        while (load > dayCapacity(off)) {
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
                if (load + taskHours(t) <= dayCapacity(adj)) { t.d = adj; edits++; }
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
          if (curLoad > 0 && curLoad + h > dayCapacity(d)) continue;
          if (curLoad + h > dayCapacity(d) && curLoad > 0) continue;
          
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

    toast('ok', '⚡ Оптимизация работ выполнена: распределено без просрочек с соблюдением 8-часового рабочего дня.');
    refresh();
  }
  function autoSchedule() { optimizeWorksCalendar(); }

  /* =====================================================================
     РЕНДЕР: КАРТА МАРШРУТОВ
     ===================================================================== */
  var ymState = { token: 0, loaded: false, loading: false, waiting: [], ymap: null, pts: [], route: null, manualOrder: false, leafletMap: null, leafletRouteLayer: null, leafletArrows: [], leafletMarkers: [], roadClosures: [], closureLayers: [], manualClosures: [], drawingClosure: false, drawPoints: [] };
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
      // Координаты: ПРЯМО из задачи, затем из объекта
      var lat = (t.lat != null) ? t.lat : (o ? o.lat : null);
      var lng = (t.lng != null) ? t.lng : (o ? o.lng : null);
      var travelMin = t.travelMin != null ? t.travelMin : null;
      var travelKm = t.travelKm != null ? t.travelKm : null;
      var travelKmText = t.travelKmText != null ? t.travelKmText : (travelKm != null ? travelKm.toFixed(1).replace('.', ',') + ' км' : null);
      var travelText = t.travelText != null ? t.travelText : (travelMin != null ? fmtDuration(travelMin) : null);
      if (lat != null && lng != null) prevObj = { lat: lat, lng: lng };
      return { id: t.id, lat: lat, lng: lng, addr: addrOf(t), addr_be: t.addr_be || addrOf(t), type: o ? o.type : '—', work: w ? w.name : '?', master: m ? m.name : '?', mcol: m ? m.color : '#94a3b8', hours: taskHours(t), norm: w ? w.norm : 0, travelMin: travelMin, travelText: travelText, travelKm: travelKm, travelKmText: travelKmText };
    });

    var prov = S.mapProvider || 'osrm';
    var provSelHTML = '<div style="display:flex;align-items:center;gap:6px;margin-left:auto;"><span style="font-size:12px;color:var(--ink);font-weight:700;">Выбор карты:</span><select id="map-provider-sel" style="padding:5px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;background:#fff;color:var(--ink);font-weight:700;cursor:pointer;">' +
      '<option value="yandex"' + (prov === 'yandex' ? ' selected' : '') + '>Яндекс карта</option>' +
      '<option value="osrm"' + (prov === 'osrm' ? ' selected' : '') + '>OpenStreetMap</option>' +
    '</select></div>';

    var html = '<div class="cal-head"><div class="seg">' +
      '<button class="' + (off === -1 ? 'on' : '') + '" data-action="map-off" data-off="-1">Вчера</button>' +
      '<button class="' + (off === 0 ? 'on' : '') + '" data-action="map-off" data-off="0">Сегодня</button>' +
      '<button class="' + (off === 1 ? 'on' : '') + '" data-action="map-off" data-off="1">Завтра</button></div>' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span style="font-size:12.5px;color:var(--muted);font-weight:600;">Выбрать дату:</span>' +
        '<input type="date" id="map-date-sel" value="' + key(offToDate(off)) + '" style="padding:5px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;font-family:inherit;background:#fff;color:var(--ink);font-weight:600;cursor:pointer;" title="Выбрать любую дату для просмотра маршрута">' +
      '</div>' +
      (S.role === 'viewer' || prov === 'yandex' ? '' : '<button class="btn sm" id="btn-draw-closure" title="Отметить закрытый участок дороги на карте" style="background:#dc2626;color:#fff;border-color:#dc2626;">🚧 Закрытие</button>') +
      (S.role === 'viewer' ? '' : '<button class="btn sm" id="btn-delete-closure" style="display:none;background:#b91c1c;color:#fff;border-color:#b91c1c;" title="Удалить выбранный закрытый участок дороги">🗑 Удалить выбранное</button>') +
      (S.role === 'viewer' ? '<span style="font-size:12px;color:var(--muted);font-weight:600;">👁 Режим просмотра</span>' : '<button class="btn primary" id="btn-build-route" data-action="build-route" disabled style="opacity:.5;cursor:not-allowed;">' + IC.route + ' Оптимизация маршрутов</button>' + '<button class="btn sm" id="btn-drive3d" style="background:#dc2626;color:#fff;border-color:#dc2626;display:none;" title="3D-вождение автомобиля по улицам Минска (открывается кодом ↑↓←→)">🏎 Дать газу</button>') +
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
    // Блок базы — как задание, в конце списка
    var existRT = getRouteTime(S.mapMaster !== 'all' ? S.mapMaster : null, off);
    html += '<div class="mtask base-card" id="map-base-card" style="background:linear-gradient(135deg,#0f2740,#1a3a5c);color:#fff;border-color:transparent;cursor:default;">' +
      '<div class="mtask-grip" style="color:rgba(255,255,255,.35);cursor:default;">' + IC.grip + '</div>' +
      '<div class="pin" style="background:#fff;color:#0f2740;font-size:14px;">🏁</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;font-size:12.5px;margin-bottom:3px;color:#fff">📍 ' + esc(base.name) + '</div>' +
        '<div style="font-size:11.5px;color:#93c5fd;margin-bottom:2px">🏠 База · точка возврата</div>' +
        '<div style="font-size:11.5px;color:#cbd5e1;" id="base-return-info">' + (existRT && existRT.lastLegMin ? '🛣 От последнего задания: <b style="color:#fff">' + fmtDuration(existRT.lastLegMin) + '</b> · ' + (existRT.lastLegKm || 0).toFixed(1).replace('.', ',') + ' км' : 'Маршрут до базы рассчитается при оптимизации') + '</div>' +
      '</div></div>';
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
      if (!id) return; // карточка базы (нет data-mid) — не обрабатываем
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
      reorderMapCard(mapDragId, card.dataset.mid);
    });

// Привязка кнопки ручной разметки закрытых дорог
    var drawBtn = document.getElementById('btn-draw-closure');
    if (drawBtn) drawBtn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (ymState.leafletMap) {
        if (ymState.drawingClosure) {
          finishDrawingClosure(ymState.leafletMap);
        } else {
          startDrawingClosure(ymState.leafletMap);
        }
      } else {
        toast('warn', 'Карта ещё загружается...');
      }
    };
    var delClosureBtn = document.getElementById('btn-delete-closure');
    if (delClosureBtn) delClosureBtn.onclick = function(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (ymState.leafletMap) deleteSelectedClosure(ymState.leafletMap);
      else toast('warn', 'Карта ещё загружается...');
    };
    drawMap(pts);
    var mSel = document.getElementById('map-master-sel');
    if (mSel) mSel.addEventListener('change', function (e) { S.mapMaster = e.target.value; renderMap(); });
    var drive3dBtn = document.getElementById('btn-drive3d');
    if (drive3dBtn) drive3dBtn.onclick = function (e) { if (e) { e.preventDefault(); e.stopPropagation(); } openDrive3D(); };
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
    s.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU';
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
     МОДУЛЬ ЯНДЕКС.КАРТ И ОПТИМИЗАЦИИ МАРШРУТОВ 
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
    // Всегда включаем слой трафика (пробки, ремонтные работы, закрытия дорог)
    url += '&l=map';
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
    // Включаем слой трафика для просмотра закрытых участков
    url += '&l=map';
    return url;
  }

  // 2. Отображение начальной карты при заходе на страницу (БЕЗ изменения порядка заданий!)
  function drawMap(pts) {
    // Храним ВСЕ задания (вкл и выкл)
    ymState.allPts = pts;
    // Активные — для маршрута
    var sel = pts.filter(function (p) { return S.mapSel[p.id]; });
    // Неактивные — остаются на карте (серые)
    var inactive = pts.filter(function (p) { return !S.mapSel[p.id]; });
    ymState.inactivePts = inactive;
    var canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    if (pts.returnTrip) sel.returnTrip = pts.returnTrip;
    ymState.pts = sel;
    setRouteInfo(null);

    var base = currentBase();
    var prov = S.mapProvider || "osrm";

    // Для не-Leaflet карт (Яндекс/iframe) — кнопка сразу активна (геокодирование не нужно)
    if (prov !== "osrm" && prov !== "graphhopper" && prov !== "ors" && prov !== "valhalla") {
      var brBtn = document.getElementById('btn-build-route');
      if (brBtn) { brBtn.disabled = false; brBtn.style.opacity = ''; brBtn.style.cursor = ''; }
    }

    // === OSM-движки: сразу рендерим Leaflet, без iframe ===
    if ((prov === "osrm" || prov === "graphhopper" || prov === "ors" || prov === "valhalla") && sel.length >= 1) {
      renderLeafletMap(canvas, sel, base, prov, inactive);
      return;
    }

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
      } else if (prov === "osm" || prov === "2gis") {
        applyOsmRouteStats(sel, base, function(success, totalKm) {
          refreshMapCards(sel); if (totalKm > 0) setRouteInfo({ km: totalKm, count: sel.length });
        });
      } else {
          // Статистика маршрута через OSRM (бесплатно, без ключа Яндекс.Карт)
          fetchOSMRouteGeometry('osrm', sel, base, function(result) {
            if (result.ok && result.geometry.length > 0) {
              var jamsMin = result.min + 10;
              var freeMin = Math.round(result.min * 0.85) + 10;
              setRouteInfo({ km: result.km, jamsMin: jamsMin, freeMin: freeMin, count: sel.length });
              if (result.legs && result.legs.length > 0) {
                sel.forEach(function(p, idx) {
                  if (idx < result.legs.length) {
                    var leg = result.legs[idx];
                    var legKm = (leg.distance || 0) / 1000;
                    p.travelKm = legKm; p.travelKmText = legKm.toFixed(1).replace('.', ',') + ' км';
                    p.travelMin = Math.max(1, Math.round((leg.duration || 0) / 60)); p.travelText = fmtDuration(p.travelMin);
                  }
                });
                refreshMapCards(sel);
              }
            }
          });
        }
    } else {
      var baseMapUrl = "https://yandex.ru/map-widget/v1/?ll=" + base.lng + "," + base.lat + "&z=14&pt=" + base.lat + "," + base.lng + ",pm2rdm&l=map";
      if (prov === "google") baseMapUrl = "https://www.google.com/maps?q=" + encodeURIComponent("Минск, " + base.name) + "&output=embed";
      else if (prov === "osm" || prov === "osrm" || prov === "graphhopper" || prov === "ors" || prov === "valhalla") baseMapUrl = "https://www.openstreetmap.org/export/embed.html?bbox=" + (base.lng - 0.05) + "," + (base.lat - 0.03) + "," + (base.lng + 0.05) + "," + (base.lat + 0.03) + "&layer=mapnik&marker=" + base.lat + "," + base.lng;
      else if (prov === "2gis") baseMapUrl = "https://2gis.by/minsk?m=" + base.lng + "%2C" + base.lat + "%2F14";
      canvas.style.position = "relative";
      canvas.innerHTML = "<iframe class='route-frame' src='" + baseMapUrl + "' allowfullscreen loading='lazy' title='База (" + prov + ")'></iframe>";
    }
  }

  // 3. Главная функция оптимизации при клике на кнопку «Оптимизация маршрутов» (для всех 4 карт: Яндекс, Google, OSM, 2ГИС)
  // === Загрузка Leaflet ===
  var leafletLoaded = false, leafletLoading = false, leafletCallbacks = [];
  function ensureLeaflet(callback) {
    if (leafletLoaded && window.L) { callback(); return; }
    if (leafletLoading) { leafletCallbacks.push(callback); return; }
    leafletLoading = true; leafletCallbacks = [callback];
    // CSS
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    // JS
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = function() {
      leafletLoaded = true; leafletLoading = false;
      leafletCallbacks.forEach(function(cb) { cb(); }); leafletCallbacks = [];
    };
    s.onerror = function() {
      leafletLoading = false;
      leafletCallbacks.forEach(function(cb) { cb(); }); leafletCallbacks = [];
    };
    document.head.appendChild(s);
  }

  // === Загрузчик MapTiler OMT (векторные тайлы с подписями ТОЛЬКО на русском) ===
  // Для русского языка нужны именно ВЕКТОРНЫЕ тайлы (растровые рендерятся на сервере,
  // язык в них не переключить). Используется официальный плагин leaflet-maptilersdk,
  // который через MapLibre GL рисует векторные тайлы поверх Leaflet и поддерживает
  // флаг language → использует поле name:ru из схемы OpenMapTiles.
  var maptilerSdkLoaded = false, maptilerSdkLoading = false, maptilerCallbacks = [];
  function ensureMapTiler(callback) {
    var key = (window.SP_CONFIG && SP_CONFIG.maptilerApiKey) || '';
    if (!key) { callback(false); return; }                       // ключа нет — плагин не грузим
    if (maptilerSdkLoaded && (window.L.maptilerLayer || (window.L.maptiler && window.L.maptiler.maptilerLayer))) { callback(true); return; }
    if (maptilerSdkLoading) { maptilerCallbacks.push(callback); return; }
    maptilerSdkLoading = true; maptilerCallbacks = [callback];
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://cdn.maptiler.com/maptiler-sdk-js/v1.1.2/maptiler-sdk.css';
    document.head.appendChild(css);
    var sdk = document.createElement('script');
    sdk.src = 'https://cdn.maptiler.com/maptiler-sdk-js/v1.1.2/maptiler-sdk.umd.js';
    sdk.onload = function () {
      var plug = document.createElement('script');
      plug.src = 'https://cdn.maptiler.com/leaflet-maptilersdk/v1.0.0/leaflet-maptilersdk.js';
      plug.onload = function () {
        maptilerSdkLoaded = true; maptilerSdkLoading = false;
        maptilerCallbacks.forEach(function (cb) { cb(true); }); maptilerCallbacks = [];
      };
      plug.onerror = function () {
        maptilerSdkLoading = false;
        maptilerCallbacks.forEach(function (cb) { cb(false); }); maptilerCallbacks = [];
      };
      document.head.appendChild(plug);
    };
    sdk.onerror = function () {
      maptilerSdkLoading = false;
      maptilerCallbacks.forEach(function (cb) { cb(false); }); maptilerCallbacks = [];
    };
    document.head.appendChild(sdk);
  }

  // Принудительно переписывает ВСЕ текстовые подписи стиля на русский (поле name:ru).
  // Обходит баг SDK v1.1.2: его подмена языка (setPrimaryLanguage) ловит только простые
  // форматы {name}/{name:en}, но пропускает выражения coalesce — из-за чего названия
  // улиц (Road labels), городов (Town labels), озёр (Lake labels) оставались на name:en (латиница),
  // хотя в данных name:ru есть для 100% улиц Минска.
  function forceRussianStyle(style) {
    if (!style || !style.layers) return style;
    var ru = ['coalesce', ['get', 'name:ru'], ['get', 'name']];
    style.layers.forEach(function (layer) {
      if (!layer.layout || !layer.layout['text-field']) return;
      var tf = layer.layout['text-field'];
      if (typeof tf === 'string') {
        if (/\{\s*name\b/.test(tf)) layer.layout['text-field'] = ru;     // {name}, {name:en}
      } else if (Array.isArray(tf)) {
        var j = JSON.stringify(tf);
        if (j.indexOf('"name"') !== -1 || j.indexOf('"name:') !== -1) layer.layout['text-field'] = ru;
      }
    });
    return style;
  }

  // Добавляет слой MapTiler OMT с подписями ТОЛЬКО на русском языке.
  // map — уже созданный объект Leaflet.
  function addMapTilerBasemap(map) {
    var key = (window.SP_CONFIG && SP_CONFIG.maptilerApiKey) || '';
    if (!key) {
      var warn = document.createElement('div');
      warn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border:2px solid var(--red);border-radius:12px;padding:18px 22px;text-align:center;z-index:1000;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:13px;color:var(--ink);';
      warn.innerHTML = '<div style="font-size:24px;margin-bottom:8px">🗺️</div><b style="color:var(--red);font-size:14px">Слой карты MapTiler не загрузился</b><br><br>Добавьте бесплатный ключ MapTiler в <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">config.js</code> → <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">maptilerApiKey</code><br><br><span style="font-size:12px;color:var(--muted)">Получить бесплатно (без карты): <b>cloud.maptiler.com/account/keys</b> → 100 000 загрузок/мес</span>';
      map.getContainer().appendChild(warn);
      return;
    }
    ensureMapTiler(function (ok) {
      if (!map || !map.getContainer) return;                      // карту уже удалили
      var factory = window.L.maptilerLayer || (window.L.maptiler && window.L.maptiler.maptilerLayer);
      if (!ok || !factory) { toast('err', 'Не удалось загрузить плагин MapTiler. Проверьте интернет-соединение.'); return; }
      // Грузим стиль, ПРИНУДИТЕЛЬНО переписываем все подписи на name:ru и передаём объектом.
      // Это обходит баг SDK (coalesce не заменяется) — гарантия русского во ВСЕХ слоях.
      fetch('https://api.maptiler.com/maps/streets-v2/style.json?key=' + key)
        .then(function (r) { return r.json(); })
        .then(function (style) {
          forceRussianStyle(style);
          factory({ apiKey: key, style: style, tileSize: 512, zoomOffset: -1, crossOrigin: true }).addTo(map);
        })
        .catch(function (e) {
          console.warn('Стиль не загружен для переработки, fallback на language:', e);
          factory({ apiKey: key, style: 'streets', language: 'ru', tileSize: 512, zoomOffset: -1, crossOrigin: true }).addTo(map);
        });
    });
  }

  // === Стрелки направления движения по маршруту ===
  // Проходит по геометрии маршрута и ставит маленькие стрелочки (►) каждые ~12% длины,
  // повёрнутые по азимуту движения. Наглядно показывает, куда едет автомобиль.
  function addDirectionArrows(map, latlngs) {
    if (ymState.leafletArrows) { ymState.leafletArrows.forEach(function(a) { try { a.remove(); } catch(e) {} }); }
    ymState.leafletArrows = [];
    if (!latlngs || latlngs.length < 2 || !window.L) return;

    // Считаем длины отрезков и общую длину
    var segs = [], total = 0;
    for (var i = 1; i < latlngs.length; i++) {
      var d = distKm({ lat: latlngs[i - 1][0], lng: latlngs[i - 1][1] }, { lat: latlngs[i][0], lng: latlngs[i][1] });
      segs.push({ from: latlngs[i - 1], to: latlngs[i], len: d, acc: total });
      total += d;
    }
    if (total < 0.15) return;

    // Надёжный алгоритм: ровно numArrows стрелок, равномерно по всей длине
    var numArrows = Math.min(20, Math.max(3, Math.ceil(total / 1.2)));
    var step = total / numArrows;

    for (var n = 0; n < numArrows; n++) {
      var dist = step * (n + 0.5);  // позиция стрелки по длине маршрута
      // Находим отрезок, в который попадает эта дистанция
      for (var s = 0; s < segs.length; s++) {
        var seg = segs[s];
        if (dist >= seg.acc && dist < seg.acc + seg.len && seg.len > 0.001) {
          var frac = (dist - seg.acc) / seg.len;
          var lat = seg.from[0] + (seg.to[0] - seg.from[0]) * frac;
          var lng = seg.from[1] + (seg.to[1] - seg.from[1]) * frac;
          var bearing = calcBearing(seg.from[0], seg.from[1], seg.to[0], seg.to[1]);
          var rotation = bearing - 90;  // ➤ смотрит вправо по умолчанию
          var icon = window.L.divIcon({
            html: '<div style="transform:rotate(' + rotation + 'deg);font-size:18px;color:#fff;line-height:1;text-shadow:0 1px 4px rgba(37,99,235,.95),0 0 2px #2563eb;transform-origin:center;">\u27A4</div>',
            className: '', iconSize: [18, 18], iconAnchor: [9, 9]
          });
          var arrow = window.L.marker([lat, lng], { icon: icon, interactive: false, keyboard: false });
          arrow.addTo(map);
          ymState.leafletArrows.push(arrow);
          break;  // стрелка найдена, переходим к следующей
        }
      }
    }
  }

  // Азимут (угол направления от точки A к точке B), в градусах 0..360
  function calcBearing(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    var dLng = (lng2 - lng1) * toRad;
    var y = Math.sin(dLng) * Math.cos(lat2 * toRad);
    var x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
    var brng = Math.atan2(y, x) * toDeg;
    return (brng + 360) % 360;
  }

  // Перерисовка маркеров на карте после оптимизации порядка (новые номера 1,2,3...)
  function redrawOptimizedMarkers(ordered) {
    if (!ymState.leafletMap || !window.L || !ordered || !ordered.length) return;
    if (ymState.leafletMarkers) { ymState.leafletMarkers.forEach(function(mk) { try { mk.remove(); } catch(e) {} }); }
    ymState.leafletMarkers = [];
    var colors = ['#2563eb','#dc2626','#16a34a','#ca8a04','#7c3aed','#0891b2','#db2777'];
    // Активные маркеры с номерами
    ordered.forEach(function(p, i) {
      if (p.lat == null || p.lng == null) return;
      var numIcon = window.L.divIcon({
        html: '<div style="background:' + (p.mcol || colors[i % colors.length]) + ';color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">' + (i + 1) + '</div>',
        className: '', iconSize: [26, 26], iconAnchor: [13, 13]
      });
      var mk = window.L.marker([p.lat, p.lng], { icon: numIcon }).addTo(ymState.leafletMap)
        .bindPopup('<b>' + esc(p.addr || '?') + '</b><br>' + esc(p.work || ''));
      ymState.leafletMarkers.push(mk);
    });
    // Неактивные маркеры (серые, остаются на месте)
    if (ymState.inactivePts && ymState.inactivePts.length) {
      ymState.inactivePts.forEach(function(p) {
        if (p.lat == null || p.lng == null) return;
        var grayIcon = window.L.divIcon({
          html: '<div style="background:#cbd5e1;color:#94a3b8;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);opacity:.6">\u25CB</div>',
          className: '', iconSize: [22, 22], iconAnchor: [11, 11]
        });
        var mk = window.L.marker([p.lat, p.lng], { icon: grayIcon, interactive: false }).addTo(ymState.leafletMap);
        ymState.leafletMarkers.push(mk);
      });
    }
  }

  // === Ручная разметка закрытых дорог на карте ===
  // Пользователь кликает по карте, создавая точки. Двойной клик — завершить.
  // Закрытый участок сохраняется и используется для объезда маршрута.
  var CLOSURES_KEY = 'smartplan_manual_closures';
  function getManualClosures() {
    try { var raw = localStorage.getItem(CLOSURES_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
    return [];
  }
  function saveManualClosures(closures) {
    try { localStorage.setItem(CLOSURES_KEY, JSON.stringify(closures)); } catch(e) {}
  }

  function startDrawingClosure(map) {
    if (ymState.drawingClosure) { finishDrawingClosure(map); return; }
    ymState.drawingClosure = true;
    var btn = document.getElementById('btn-draw-closure');
    if (btn) { btn.textContent = '✓ Завершить'; btn.style.background = '#16a34a'; }
    ymState.drawPoints = [];
    ymState._tempMarkers = [];
    ymState._lastClosureLL = null;
    toast('info', '🚧 Кликайте по карте, расставляя точки закрытого участка. Готово — нажмите «✓ Завершить» (нужно ≥ 2 точек).');
    map._closureClickHandler = function(e) {
      var ll = [e.latlng.lat, e.latlng.lng];
      // Защита от случайного двойного клика: пропускаем клик в ту же точку подряд
      if (ymState._lastClosureLL) {
        var dx = ymState._lastClosureLL[0] - ll[0], dy = ymState._lastClosureLL[1] - ll[1];
        if (dx * dx + dy * dy < 1e-12) return;
      }
      ymState._lastClosureLL = ll;
      ymState.drawPoints.push(ll);
      if (ymState._tempLine) { try { ymState._tempLine.remove(); } catch (ex) {} }
      if (ymState.drawPoints.length >= 2) {
        ymState._tempLine = window.L.polyline(ymState.drawPoints, { color: '#dc2626', weight: 5, opacity: 0.8, dashArray: '6,4' }).addTo(map);
      }
      var cm = window.L.circleMarker(e.latlng, { radius: 5, color: '#dc2626', fillColor: '#fff', fillOpacity: 1 }).addTo(map);
      ymState._tempMarkers.push(cm);
    };
    map.on('click', map._closureClickHandler);
    map.doubleClickZoom.disable();
  }

  function finishDrawingClosure(map) {
    if (!ymState.drawingClosure) return;
    ymState.drawingClosure = false;
    var btn = document.getElementById('btn-draw-closure');
    if (btn) { btn.textContent = '🚧 Закрытие'; btn.style.background = '#dc2626'; }
    map.off('click', map._closureClickHandler);
    map.doubleClickZoom.enable();
    if (ymState._tempLine) { try { ymState._tempLine.remove(); } catch (e) {} ymState._tempLine = null; }
    if (ymState._tempMarkers) { ymState._tempMarkers.forEach(function (m) { try { m.remove(); } catch (e) {} }); ymState._tempMarkers = []; }
    if (ymState.drawPoints.length >= 2) {
      var mc = getManualClosures();
      var name = 'Закрытие №' + (mc.length + 1);
      var closure = { latlngs: ymState.drawPoints.slice(), name: name, type: 'manual', manual: true };
      ymState.roadClosures.push(closure);
      mc.push(closure);
      saveManualClosures(mc);
      showRoadClosures(map);
      toast('ok', '✓ Закрытый участок добавлен (' + ymState.drawPoints.length + ' точек). Маршрут будет строиться в объезд.');
      logAction('Добавление закрытия дороги', name);
    } else {
      toast('warn', 'Нужно минимум 2 точки — участок не сохранён.');
    }
    ymState.drawPoints = [];
    ymState._lastClosureLL = null;
  }

  function loadManualClosures() {
    var mc = getManualClosures();
    mc.forEach(function(c) {
      // Проверяем, не добавлен ли уже
      var exists = ymState.roadClosures.some(function(r) { return r.manual && r.name === c.name && JSON.stringify(r.latlngs) === JSON.stringify(c.latlngs); });
      if (!exists) ymState.roadClosures.push(c);
    });
  }

  function clearManualClosures(map) {
    if (!window.confirm('Удалить все ручные разметки закрытых дорог?')) return;
    saveManualClosures([]);
    // Полностью пересоздаём roadClosures без ручных
    ymState.roadClosures = ymState.roadClosures.filter(function(c) { return !c.manual; });
    // Удаляем temp markers если есть
    if (ymState._tempMarkers) { ymState._tempMarkers.forEach(function(m) { try { m.remove(); } catch(e) {} }); ymState._tempMarkers = []; }
    if (map) {
      showRoadClosures(map);
    } else if (ymState.leafletMap) {
      showRoadClosures(ymState.leafletMap);
    }
    toast('ok', 'Ручные разметки очищены');
  }

  // === Загрузка закрытых/ремонтируемых дорог из OpenStreetMap (Overpass API) ===
  var closuresLoaded = false, closuresLoading = false;
  function loadRoadClosures(callback) {
    if (closuresLoaded) { callback(ymState.roadClosures); return; }
    if (closuresLoading) { setTimeout(function() { loadRoadClosures(callback); }, 2000); return; }
    closuresLoading = true;
    var query = '[out:json][timeout:25];(' +
      'way["construction"](53.7,27.3,54.1,27.9);' +
      'way["highway"="construction"](53.7,27.3,54.1,27.9);' +
      'way["highway"]["access"="no"](53.7,27.3,54.1,27.9);' +
      'way["highway"]["motor_vehicle"="no"](53.7,27.3,54.1,27.9);' +
      'way["highway"]["motorcar"="no"](53.7,27.3,54.1,27.9);' +
      'way["highway"]["disused:highway"](53.7,27.3,54.1,27.9);' +
      'way["highway"]["note"~"закрыт|перекрыт|ремонт|перекрытие",i](53.7,27.3,54.1,27.9);' +
      ');out geom;';
    fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    }).then(function(r) { return r.json(); }).then(function(data) {
      var roadTypes = ['residential','primary','secondary','tertiary','service','trunk','unclassified','yes','motorway','motorway_link'];
      var closures = [];
      (data.elements || []).forEach(function(e) {
        var tags = e.tags || {};
        var con = tags.construction || '';
        if (roadTypes.indexOf(con) !== -1 || tags.highway === 'construction') {
          var geom = e.geometry || [];
          if (geom.length >= 2) {
            var latlngs = geom.map(function(g) { return [g.lat, g.lon]; });
            closures.push({ latlngs: latlngs, name: tags.name || 'без названия', type: con || 'construction' });
          }
        }
      });
      ymState.roadClosures = closures;
      closuresLoaded = true; closuresLoading = false;
      console.log('🚧 Загружено закрытых дорог из OSM:', closures.length);
      callback(closures);
    }).catch(function(e) {
      closuresLoading = false;
      console.warn('Overpass API недоступен:', e);
      callback([]);
    });
  }

  function showRoadClosures(map) {
    if (ymState.closureLayers) { ymState.closureLayers.forEach(function(l) { try { l.remove(); } catch(e) {} }); }
    ymState.closureLayers = [];
    ymState.roadClosures.forEach(function(c) {
      var isSelected = ymState.selectedClosure === c;
      var style;
      if (c.manual && isSelected) {
        style = { color: '#16a34a', weight: 9, opacity: 1 };             // ВЫБРАНО — зелёный, сплошной
      } else if (c.manual) {
        style = { color: '#dc2626', weight: 6, opacity: 0.8, dashArray: '6,4' };
      } else {
        style = { color: '#dc2626', weight: 4, opacity: 0.5, dashArray: '6,4' };
      }
      var line = window.L.polyline(c.latlngs, style).addTo(map);
      var tip = '🚧 ' + c.name + (c.manual ? (isSelected ? ' (выбрано — нажмите «🗑 Удалить выбранное»)' : ' — нажмите, чтобы выбрать') : ' (из OSM)');
      line.bindTooltip(tip, { sticky: true });
      if (c.manual) {
        line.on('click', function() {
          // клик по заметке = ВЫБОР (не удаление); повторный клик — снятие выбора
          ymState.selectedClosure = (ymState.selectedClosure === c) ? null : c;
          showRoadClosures(map);
          updateClosureDeleteBtn();
        });
      }
      ymState.closureLayers.push(line);
    });
  }

  // Показывает/прячет кнопку удаления выбранного закрытия
  function updateClosureDeleteBtn() {
    var btn = document.getElementById('btn-delete-closure');
    if (!btn) return;
    if (ymState.selectedClosure) {
      btn.style.display = '';
      btn.textContent = '🗑 Удалить «' + (ymState.selectedClosure.name || 'закрытие') + '»';
    } else {
      btn.style.display = 'none';
    }
  }

  // Удаляет выбранное закрытие (вызывается кнопкой «🗑 Удалить выбранное»)
  function deleteSelectedClosure(map) {
    if (!ymState.selectedClosure) { toast('warn', 'Сначала выберите закрытый участок — кликните по нему.'); return; }
    var c = ymState.selectedClosure;
    ymState.roadClosures = ymState.roadClosures.filter(function(r) { return r !== c; });
    if (c.manual) {
      var mc = getManualClosures();
      mc = mc.filter(function(r) { return r.name !== c.name || JSON.stringify(r.latlngs) !== JSON.stringify(c.latlngs); });
      saveManualClosures(mc);
    }
    ymState.selectedClosure = null;
    showRoadClosures(map);
    updateClosureDeleteBtn();
    toast('ok', '✓ Закрытый участок удалён');
    logAction('Удаление закрытия дороги', c.name || '');
  }

  // === Рендер Leaflet карты для OSRM / GraphHopper / OpenRouteService ===
  function renderLeafletMap(canvas, points, base, provider, inactive) {
    ensureLeaflet(function() {
      if (!window.L) { canvas.innerHTML = '<div class="empty">Не удалось загрузить Leaflet</div>'; return; }
      canvas.style.position = 'relative';
      canvas.innerHTML = '<div id="leaflet-canvas" style="width:100%;height:100%;min-height:400px;"></div>';
      if (ymState.leafletMap) { try { ymState.leafletMap.remove(); } catch(e) {} }
      ymState.leafletMap = null;
      ymState.leafletRouteLayer = null;
      ymState.leafletArrows = [];
      ymState.drawingClosure = false;   // сброс режима рисования при пересоздании карты
      ymState.drawPoints = [];
      ymState.selectedClosure = null;   // сброс выбора закрытия

      setTimeout(function() {
        var mapEl = document.getElementById('leaflet-canvas');
        if (!mapEl || mapEl.offsetWidth === 0) { setTimeout(arguments.callee, 100); return; }

        var map = window.L.map('leaflet-canvas', { center: [base.lat, base.lng], zoom: 14, attributionControl: false, zoomControl: false });
        window.L.control.zoom({ position: 'bottomright' }).addTo(map);
        ymState.leafletMap = map;
        // Слой карты: MapTiler OMT — векторные тайлы с подписями ТОЛЬКО на русском языке
        addMapTilerBasemap(map);
        // Загружаем и показываем закрытые дороги из OpenStreetMap (Overpass API)
        loadManualClosures();
        loadRoadClosures(function() { showRoadClosures(map); });

        var allCoords = [[base.lat, base.lng]];
        var baseIcon = window.L.divIcon({ html: '<div style="font-size:28px;line-height:1">🚩</div>', className: '', iconSize: [28, 28], iconAnchor: [14, 28] });
        window.L.marker([base.lat, base.lng], { icon: baseIcon, zIndexOffset: 1000 }).addTo(map).bindPopup('<b>База</b><br>' + esc(base.name));

        var colors = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2', '#db2777'];
        var validPoints = 0;
        var allMarkers = [];

        // ИСПОЛЬЗУЕМ КООРДИНАТЫ ИЗ POINTS — без повторного геокодирования
        points.forEach(function(p, i) {
          if (p.lat != null && p.lng != null) {
            allMarkers.push({ point: p, index: i, lat: p.lat, lng: p.lng });
          }
        });

        // Геокодируем только те, у кого НЕТ координат (серийно, с паузой 1.1с — лимит Nominatim)
        var needGeocode = points.filter(function(p) { return p.lat == null || p.lng == null; });
        if (needGeocode.length > 0) {
          toast('info', '📍 Поиск координат для ' + needGeocode.length + ' адресов (по 1 в секунду)...');
          geocodeBatchSerial(needGeocode, function (p, c) {
            if (c) {
              p.lat = c.lat; p.lng = c.lng;
              allMarkers.push({ point: p, index: points.indexOf(p), lat: c.lat, lng: c.lng });
            } else {
              p.lat = base.lat + (Math.random() - 0.5) * 0.02;
              p.lng = base.lng + (Math.random() - 0.5) * 0.02;
              allMarkers.push({ point: p, index: points.indexOf(p), lat: p.lat, lng: p.lng });
              console.warn('Адрес не найден, точка рядом с базой: ' + p.addr);
            }
          }).then(drawAll);
        } else {
          drawAll();
        }

        function drawAll() {
          // Разблокируем кнопку оптимизации — координаты найдены
          var brBtn = document.getElementById('btn-build-route');
          if (brBtn) { brBtn.disabled = false; brBtn.style.opacity = ''; brBtn.style.cursor = ''; }
          allMarkers.sort(function(a, b) { return a.index - b.index; });
          // Сохраняем для последующей перерисовки с новыми номерами
          ymState.leafletDrawAllMarkers = allMarkers;
          ymState.leafletDrawAllBase = base;
          ymState.leafletColors = colors;
          drawMarkersByOrder(map, allMarkers, base, colors);

          // Рисуем линию маршрута (база → точки → база)
          var allCoords = [[base.lat, base.lng]];
          allMarkers.forEach(function(m) { allCoords.push([m.lat, m.lng]); });
          allCoords.push([base.lat, base.lng]);

          if (allCoords.length >= 2) {
            ymState.leafletRouteLayer = window.L.polyline(allCoords, {
              color: '#2563eb', weight: 4, opacity: 0.5, dashArray: '8,6'
            }).addTo(map);
            map.fitBounds(ymState.leafletRouteLayer.getBounds(), { padding: [50, 50] });
            addDirectionArrows(map, allCoords);
          }
          setTimeout(function() { map.invalidateSize(); }, 200);

          // Рисуем неактивные задания (серые маркеры без номеров)
          if (inactive && inactive.length) {
            inactive.forEach(function(p) {
              if (p.lat == null || p.lng == null) return;
              var grayIcon = window.L.divIcon({
                html: '<div style="background:#cbd5e1;color:#94a3b8;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);opacity:.6">○</div>',
                className: '', iconSize: [22, 22], iconAnchor: [11, 11]
              });
              window.L.marker([p.lat, p.lng], { icon: grayIcon, interactive: false }).addTo(map).bindPopup('<span style="color:#94a3b8">' + esc(p.addr || '?') + ' (неактивно)</span>');
            });
          }

          var provName = provider === 'valhalla' ? 'Valhalla' : provider === 'osrm' ? 'OpenStreetMap' : provider === 'graphhopper' ? 'GraphHopper' : 'OpenRouteService';
          var lp = document.createElement('div');
          lp.className = 'route-link-panel';
          lp.innerHTML = '<span>🚩 <b>База (' + esc(base.name) + ')</b> → ' + allMarkers.length + ' объектов (<b>' + provName + '</b>) → <b>База</b></span><span style="color:#94a3b8;font-size:11px">Нажмите «Оптимизация маршрутов» для расчёта</span>';
          canvas.appendChild(lp);
        }

        function drawMarkersByOrder(map, markers, base, colors) {
          // Удаляем старые маркеры
          if (ymState.leafletMarkers) { ymState.leafletMarkers.forEach(function(mk) { try { mk.remove(); } catch(e) {} }); }
          ymState.leafletMarkers = [];
          markers.forEach(function(m, displayIdx) {
            var p = m.point, i = displayIdx;
            var numIcon = window.L.divIcon({
              html: '<div style="background:' + (p.mcol || colors[i % colors.length]) + ';color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">' + (i + 1) + '</div>',
              className: '', iconSize: [26, 26], iconAnchor: [13, 13]
            });
            var mk = window.L.marker([m.lat, m.lng], { icon: numIcon }).addTo(map)
              .bindPopup('<b>' + esc(p.addr || '?') + '</b><br>' + esc(p.work || ''));
            ymState.leafletMarkers.push(mk);
          });
        }
      }, 100);
    });
  }

  // === Запрос маршрута с геометрией для OSM-движков ===
  // Кэш геокодирования в localStorage — координаты сохраняются навсегда
  function getGeocodeStore() {
    try { var raw = localStorage.getItem('smartplan_geocode'); if (raw) return JSON.parse(raw); } catch(e) {}
    return {};
  }
  function getTaskCoords(addr) {
    if (!addr) return null;
    var store = getGeocodeStore();
    return store[addr] || null;
  }
  function saveTaskCoords(addr, lat, lng) {
    if (!addr) return;
    var store = getGeocodeStore();
    store[addr] = { lat: lat, lng: lng };
    try { localStorage.setItem('smartplan_geocode', JSON.stringify(store)); } catch(e) {}
  }

  // === Хранилище времени маршрута (привязка мастер + день) ===
  // Заполняется при оптимизации маршрута на OpenStreetMap, отображается в календаре планирования.
  var ROUTE_TIME_KEY = 'smartplan_route_time';
  // Кэш фоновых расчётов маршрутов (для календаря): { 'masterId_off': {minutes, km, status} }
  var autoRouteCache = {};
  var autoRouteQueue = [];
  var autoRouteRunning = false;

  // Фоновый расчёт маршрута для мастера+дня (без UI, тихо)
  function autoCalcRoute(masterId, off, tasks) {
    var cacheKey = masterId + '_' + off;
    if (autoRouteCache[cacheKey]) return;
    if (!tasks || tasks.length === 0) return;
    autoRouteCache[cacheKey] = { status: 'loading' };
    autoRouteQueue.push({ masterId: masterId, off: off, tasks: tasks });
    processAutoRouteQueue();
  }

  // Сброс кэша фонового маршрута для ячейки — чтобы пересчитался после изменения задач
  function invalidateRouteCache(masterId, off) {
    if (!masterId || off == null) return;
    var key = masterId + '_' + off;
    delete autoRouteCache[key];
    // Чистим и сохранённые данные, иначе ячейка покажет устаревшие цифры до пересчёта
    var store = getRouteTimeStore();
    if (store[key]) {
      delete store[key];
      try { localStorage.setItem(ROUTE_TIME_KEY, JSON.stringify(store)); } catch(e) {}
    }
  }

  function processAutoRouteQueue() {
    if (autoRouteRunning || autoRouteQueue.length === 0) return;
    autoRouteRunning = true;
    var job = autoRouteQueue.shift();
    var cacheKey = job.masterId + '_' + job.off;
    var base = currentBase();
    // Берём только задачи с координатами: задача -> объект -> кэш геокодирования
    var routeTasks = [];
    job.tasks.forEach(function(t) {
      var lat = t.lat, lng = t.lng;
      if ((lat == null || lng == null) && t.o) {
        var o = OBJ_MAP[t.o];
        if (o && o.lat && o.lng) { lat = o.lat; lng = o.lng; }
      }
      if ((lat == null || lng == null) && t.addr) {
        var cached = getTaskCoords(t.addr);
        if (cached) { lat = cached.lat; lng = cached.lng; }
      }
      if (lat != null && lng != null) routeTasks.push({ t: t, lat: lat, lng: lng });
    });
    if (routeTasks.length === 0) {
      autoRouteCache[cacheKey] = { status: 'done', minutes: 0, km: 0, legs: {} };
      autoRouteRunning = false;
      processAutoRouteQueue();
      return;
    }
    // Координаты: база -> задачи (roundtrip сам вернёт на базу)
    var coords = [[base.lng, base.lat]];
    routeTasks.forEach(function(r) { coords.push([r.lng, r.lat]); });
    var coordStr = coords.map(function(c) { return c.join(','); }).join(';');
    fetch('https://router.project-osrm.org/trip/v1/driving/' + coordStr + '?roundtrip=true&source=first&overview=false')
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.trips && res.trips[0]) {
          var trip = res.trips[0];
          var wps = res.waypoints || [];
          var legs = trip.legs || [];
          var minutes = Math.round(trip.duration / 60) + 10;
          var km = trip.distance / 1000;
          // Пер-задача: время и км ДО этой задачи в оптимизированном порядке
          var taskLegs = {};
          routeTasks.forEach(function(r, idx) {
            var wp = wps[idx + 1];               // входной индекс (0 = база)
            if (!wp || wp.waypoint_index == null) return;
            var pos = wp.waypoint_index;         // позиция посещения (1..N)
            if (pos < 1 || pos > legs.length) return;
            var leg = legs[pos - 1];             // отрезок, ЗАКАНЧИВАЮЩИЙСЯ у этой задачи
            if (!leg) return;
            taskLegs[r.t.id] = {
              min: Math.max(1, Math.round((leg.duration || 0) / 60)),
              km: (leg.distance || 0) / 1000
            };
          });
          autoRouteCache[cacheKey] = { status: 'done', minutes: minutes, km: km, legs: taskLegs };
          saveRouteTime(job.masterId, job.off, minutes, km, 0, 0, taskLegs);
          // Обновляем бейдж ячейки и строки под каждой задачей (без перерисовки)
          updateCellRouteBadge(job.masterId, job.off, minutes, km);
          updateTaskLegBadges(job.masterId, job.off, taskLegs);
        } else {
          autoRouteCache[cacheKey] = { status: 'error' };
        }
        autoRouteRunning = false;
        setTimeout(processAutoRouteQueue, 500);
      }).catch(function() {
        autoRouteCache[cacheKey] = { status: 'error' };
        autoRouteRunning = false;
        setTimeout(processAutoRouteQueue, 500);
      });
  }

  // Обновление бейджа времени в ячейке календаря без перерисовки
  function updateCellRouteBadge(masterId, off, minutes, km) {
    var cells = document.querySelectorAll('.cell[data-master="' + masterId + '"][data-off="' + off + '"]');
    var txt = '🚗 ' + fmtDuration(minutes) + ' · ' + (km || 0).toFixed(1).replace('.', ',') + ' км';
    cells.forEach(function(cell) {
      var existing = cell.querySelector('.cell-route');
      if (existing) {
        existing.textContent = txt;
      } else {
        var badge = document.createElement('div');
        badge.className = 'cell-route';
        badge.textContent = txt;
        cell.appendChild(badge);
      }
    });
  }

  // Обновляет строку "🚗 мин · км" под каждой задачей в ячейке (без перерисовки сетки)
  function updateTaskLegBadges(masterId, off, legs) {
    var cells = document.querySelectorAll('.cell[data-master="' + masterId + '"][data-off="' + off + '"]');
    cells.forEach(function(cell) {
      cell.querySelectorAll('.tile[data-tid]').forEach(function(tile) {
        var tid = tile.getAttribute('data-tid');
        var leg = legs ? legs[tid] : null;
        if (!leg) return;
        var txt = '🚗 ' + fmtDuration(leg.min) + ' · ' + (leg.km || 0).toFixed(1).replace('.', ',') + ' км';
        var span = tile.querySelector('.tile-leg');
        if (span) {
          span.textContent = txt;
        } else {
          span = document.createElement('span');
          span.className = 'tile-leg';
          span.setAttribute('style', 'display:block;font-size:10px;color:#2563eb;font-weight:600;margin-top:2px;white-space:nowrap;');
          span.textContent = txt;
          var chk = tile.querySelector('.tile-chk');
          if (chk) tile.insertBefore(span, chk); else tile.appendChild(span);
        }
      });
    });
  }

  function getRouteTimeStore() {
    try { var raw = localStorage.getItem(ROUTE_TIME_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
    return {};
  }
  function saveRouteTime(masterId, dayOff, minutes, km, lastLegMin, lastLegKm, legs) {
    if (!masterId || masterId === 'all') return false;
    var store = getRouteTimeStore();
    var k = masterId + '_' + dayOff;
    var prev = store[k] || {};
    store[k] = {
      minutes: minutes, km: km, lastLegMin: lastLegMin, lastLegKm: lastLegKm,
      legs: (legs !== undefined && legs !== null) ? legs : prev.legs,
      updatedAt: Date.now()
    };
    try { localStorage.setItem(ROUTE_TIME_KEY, JSON.stringify(store)); } catch(e) {}
    return true;
  }
  function getRouteTime(masterId, dayOff) {
    if (!masterId || masterId === 'all') return null;
    var store = getRouteTimeStore();
    return store[masterId + '_' + dayOff] || null;
  }

  // Геокодирование через официальный Nominatim OpenStreetMap.
  // Ищет адрес ПРЯМО на русском. Перебирает варианты запроса, т.к. Nominatim
  // плохо находит улицу без типа (надо «улица Ленина», а не «Ленина»).
  // Универсальный геокодер: сначала Яндекс (лучше находит адреса Минска на русском),
  // при неудаче/недоступности — Nominatim (OSM). Координаты затем использует OSRM для маршрута.
  // === Геокодеры: 2GIS, OpenCage, geocode.xyz (каскад до Nominatim) ===
  function geocode2GIS(addr) {
    var key = (window.SP_CONFIG && SP_CONFIG.twogisKey) || "";
    if (!key) return Promise.resolve(null);
    var q = addr; if (q.indexOf("Минск") === -1) q = "Минск, " + q;
    return fetch("https://catalog.api.2gis.com/3.0/items/geocode?q=" + encodeURIComponent(q) + "&fields=items.point&key=" + key)
      .then(function(r){return r.json();}).then(function(d){
        if (d&&d.result&&d.result.items&&d.result.items[0]&&d.result.items[0].point) return {lat:d.result.items[0].point.lat,lng:d.result.items[0].point.lon};
        return null;}).catch(function(){return null;});
  }
  function geocodeOpenCage(addr) {
    var key = (window.SP_CONFIG && SP_CONFIG.opencageKey) || "";
    if (!key) return Promise.resolve(null);
    return fetch("https://api.opencagedata.com/geocode/v1/json?q=" + encodeURIComponent(addr) + "&key=" + key + "&language=ru&countrycode=by&limit=1")
      .then(function(r){return r.json();}).then(function(d){
        if (d&&d.results&&d.results[0]&&d.results[0].geometry) return {lat:d.results[0].geometry.lat,lng:d.results[0].geometry.lng};
        return null;}).catch(function(){return null;});
  }
  function geocodeXYZ(addr) {
    var q = addr.replace(/^г\.?\s*[Мм]инск[,]\s*/, "").trim();
    if (q.indexOf("Минск") === -1) q = q + ", Минск";
    return fetch("https://geocode.xyz/?json=1&locate=" + encodeURIComponent(q))
      .then(function(r){return r.json();}).then(function(d){
        if (d && !d.error && d.standard && d.standard.latt && d.standard.longt) {
          var la = parseFloat(d.standard.latt), ln = parseFloat(d.standard.longt);
          if (!isNaN(la) && !isNaN(ln)) return {lat: la, lng: ln};
        } return null;}).catch(function(){return null;});
  }
  // Каскад: 2GIS → OpenCage → geocode.xyz → Nominatim (с раскрытием сокращений)
  function geocodeCascading(addr) {
    if (!addr || addr === "?") return Promise.resolve(null);
    var stored = getTaskCoords(addr); if (stored) return Promise.resolve(stored);
    return new Promise(function(resolve){
      var k2=(window.SP_CONFIG&&SP_CONFIG.twogisKey)||"", kOC=(window.SP_CONFIG&&SP_CONFIG.opencageKey)||"";
      var steps=[];
      if(k2) steps.push(function(){return geocode2GIS(addr);});
      if(kOC) steps.push(function(){return geocodeOpenCage(addr);});
      steps.push(function(){return geocodeXYZ(addr);});
      steps.push(function(){return geocodeAddressNominatim(addr);});
      function tryNext(i){
        if(i>=steps.length){resolve(null);return;}
        steps[i]().then(function(c){
          if(c&&!isNaN(parseFloat(c.lat))&&!isNaN(parseFloat(c.lng))){saveTaskCoords(addr,c.lat,c.lng);resolve(c);}
          else tryNext(i+1);
        }).catch(function(){tryNext(i+1);});
      }
      tryNext(0);
    });
  }
  function geocodeAddressUnified(addr) {
    return new Promise(function (resolve) {
      var settled = false;
      function fallback() { geocodeCascading(addr).then(function (c) { if (!settled) { settled = true; resolve(c); } }); }
      function tryYandex() {
        geocodeAddr(addr).then(function (c) {
          if (settled) return;
          if (c && c[0] != null) { settled = true; resolve({ lat: c[0], lng: c[1] }); }
          else fallback();
        });
      }
      if (window.ymaps && window.ymaps.geocode) tryYandex();
      else ensureYandex(tryYandex, fallback);
      setTimeout(function () { if (!settled) { settled = true; fallback(); } }, 4000); // защита от зависания Яндекса
    });
  }

  // Фоновое геокодирование адресов заданий через Яндекс.Карты:
  // находит координаты по адресам (in-place записывает их в точки) и
  // передаёт эти точки в OpenStreetMap (OSRM) для построения маршрута.
  function geocodePointsViaYandex(points) {
    return new Promise(function (resolve) {
      if (!points || !points.length) { resolve(points || []); return; }
      ensureYandex(function () {
        var idx = 0;
        function next() {
          if (idx >= points.length) { resolve(points); return; }
          var p = points[idx]; idx++;
          var addr = (p.addr || '').trim();
          if (!addr || addr === '?') { setTimeout(next, 20); return; }
          geocodeAddr(addr).then(function (c) {
            // Яндекс вернул координаты [lat, lng] → перезаписываем точку
            if (c && c[0] != null && !isNaN(parseFloat(c[0])) && !isNaN(parseFloat(c[1]))) {
              p.lat = parseFloat(c[0]); p.lng = parseFloat(c[1]);
              var st = findTask(p.id);
              if (st) { st.lat = p.lat; st.lng = p.lng; if (TASKS_DB) TASKS_DB.updateTask(st.id, st); }
            }
            setTimeout(next, 250); // мягкая пауза между запросами к геокодеру Яндекса
          });
        }
        next();
      }, function () {
        // Яндекс недоступен — точки остаются как есть; fetchOSMRouteGeometry сделает fallback на Nominatim
        resolve(points);
      });
    });
  }

  // Словарь сокращений минских адресов для Nominatim (OSM не понимает аббревиатуры)
  var STREET_ABBR = {
    "к.либкнехта":"Карла Либкнехта","к.маркса":"Карла Маркса","к.цеткин":"Клары Цеткин",
    "в.хоружей":"Веры Хоружей","я.коласа":"Янки Коласа","я.купалы":"Янки Купалы",
    "ф.скорины":"Франциска Скорины","м.богдановича":"Максима Богдановича",
    "п.бровки":"Петруся Бровки","п.глебки":"Петруся Глебки","р.люксембург":"Розы Люксембург",
    "с.ковалевской":"Софьи Ковалевской","а.герцена":"Александра Герцена",
    "н.кедышки":"Николая Кедышки","и.павлова":"Ивана Павлова","д.сердича":"Дмитрия Сердича",
    "в.горбачевой":"Веры Горбачевой","а.невского":"Александра Невского",
    "в.короткевича":"Василия Короткевича","н.гоголя":"Николая Гоголя",
    "л.толстого":"Льва Толстого","а.чехова":"Антона Чехова","м.горького":"Максима Горького",
    "в.маяковского":"Владимира Маяковского","с.есенина":"Сергея Есенина",
    "а.пушкина":"Александра Пушкина","п.мстиславца":"Петра Мстиславца",
    "в.ливенцева":"Вениамина Ливенцева","г.ширмы":"Григория Ширмы",
    "е.полотило":"Ефима Полотило","а.сахарова":"Андрея Сахарова","м.танка":"Максима Танка"
  };
  // Раскрывает сокращения: «К.Либкнехта 118» → «Карла Либкнехта 118», «пр.Независимости» → «проспект Независимости»
  function expandAbbr(addr) {
    if (!addr) return addr;
    var norm = addr.replace(/([\u0410-\u042F\u0401A-Z])\.\s+/g, "$1.").replace(/\s+/g, " ").trim();
    var low = norm.toLowerCase();
    for (var k in STREET_ABBR) {
      var pos = low.indexOf(k);
      if (pos !== -1 && (pos === 0 || /[\s.]/.test(low.charAt(pos - 1)))) {
        norm = norm.substring(0, pos) + STREET_ABBR[k] + norm.substring(pos + k.length);
        break;
      }
    }
    norm = norm.replace(/^пр-т[\.\s]+/i, "проспект ").replace(/^пр\.\s*/i, "проспект ")
      .replace(/^ул\.\s*/i, "улица ").replace(/^пер\.\s*/i, "переулок ")
      .replace(/^пл\.\s*/i, "площадь ").replace(/^бул\.\s*/i, "бульвар ")
      .replace(/^ш\.\s*/i, "шоссе ").replace(/^наб\.\s*/i, "набережная ")
      .replace(/^(мкр-н|мкр)\.\s*/i, "микрорайон ");
    return norm;
  }
  function geocodeAddressNominatim(addr) {
    if (!addr || addr === '?') return Promise.resolve(null);
    var stored = getTaskCoords(addr);
    if (stored) return Promise.resolve(stored);

    // Нормализуем: убираем «г. Минск» в начале, добавляем «, Минск» если города нет
    var cleanAddr = addr.replace(/^г\.?\s*[Мм]инск[,\s]*/, '').trim();
    if (cleanAddr.indexOf('Минск') === -1 && cleanAddr.indexOf('Мінск') === -1) cleanAddr = cleanAddr + ', Минск';
    cleanAddr = expandAbbr(cleanAddr); // раскрыть К.→Карла, пр.→проспект и т.д.

    // Паттерны типов улиц (сокращения и полные формы)
    var streetTypes = /^(улица|ул|пр-т|проспект|пр|переулок|пер|площадь|пл|бульвар|бул|шоссе|ш|набережная|наб|тупик|аллея|проезд|микрорайон|мкр|мкр-н|поселок|пос)\b/i;

    // Генерируем варианты запроса от наиболее вероятного к менее вероятному
    var variants = [cleanAddr];
    if (!streetTypes.test(cleanAddr)) {
      // Нет типа улицы → добавляем варианты с типом
      variants.push('улица ' + cleanAddr);                          // «улица Ленина, 5, Минск»
      variants.push('ул. ' + cleanAddr);                            // «ул. Ленина, 5, Минск»
    }

    // Перебираем варианты последовательно до первого успешного (с паузой 1.1с — лимит Nominatim)
    function tryVariant(idx) {
      if (idx >= variants.length) return Promise.resolve(null);
      var q = variants[idx];
      var params = 'q=' + encodeURIComponent(q) +
        '&format=json&limit=3&accept-language=ru&countrycodes=by&addressdetails=1' +
        '&viewbox=27.30,54.10,27.90,53.75&bounded=1';
      return fetch('https://nominatim.openstreetmap.org/search?' + params)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.length) {
            var lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
            if (!isNaN(lat) && !isNaN(lng)) {
              var result = { lat: lat, lng: lng };
              saveTaskCoords(addr, result.lat, result.lng); // кэшируем (требование политики)
              return result;
            }
          }
          return null; // этот вариант не нашёл
        })
        .catch(function() { return null; })
        .then(function(found) {
          if (found) return found;
          return new Promise(function(resolve) { setTimeout(function() { resolve(tryVariant(idx + 1)); }, 1100); });
        });
    }

    return tryVariant(0);
  }

  // Серийное геокодирование списка адресов с паузой 1.1с между запросами.
  // Nominatim требует максимум 1 запрос/сек. Адреса без координат геокодируются по очереди.
  function geocodeBatchSerial(addresses, onEach) {
    return new Promise(function (resolve) {
      var results = [];
      var i = 0;
      function next() {
        if (i >= addresses.length) { resolve(results); return; }
        var addrItem = addresses[i];
        geocodeCascading(addrItem.addr || '').then(function (c) {
          results.push({ src: addrItem, coords: c });
          if (onEach) onEach(addrItem, c);
          i++;
          setTimeout(next, 1100); // 1.1с пауза — политика Nominatim
        });
      }
      next();
    });
  }

  // Создание полигонов-обходов вокруг закрытых дорог (для ORS avoid_polygons)
  function buildAvoidPolygons() {
    var bufferDeg = 0.001; // ~100 метров буфер вокруг закрытия
    var polygons = [];
    // Используем ТОЛЬКО ручные разметки
    var manualOnly = ymState.roadClosures.filter(function(c) { return c.manual; });
    manualOnly.forEach(function(c) {
      // Создаём ОДИН bounding-box полигон на всё закрытие
      var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      c.latlngs.forEach(function(p) {
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLng) minLng = p[1];
        if (p[1] > maxLng) maxLng = p[1];
      });
      // Расширяем на буфер
      minLat -= bufferDeg; maxLat += bufferDeg;
      minLng -= bufferDeg; maxLng += bufferDeg;
      // GeoJSON [lng, lat]
      polygons.push([[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]);
    });
    return polygons;
  }

  // Полигоны закрытий для Valhalla exclude_polygons (ВСЕ источники: OSM + ручные).
  function buildExcludePolygons() {
    var bufferDeg = 0.0009;
    var polygons = [];
    ymState.roadClosures.forEach(function(c) {
      if (!c.latlngs || c.latlngs.length < 1) return;
      var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      c.latlngs.forEach(function(p) {
        if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1];
      });
      if (minLat === maxLat) { minLat -= 0.0003; maxLat += 0.0003; }
      if (minLng === maxLng) { minLng -= 0.0003; maxLng += 0.0003; }
      minLat -= bufferDeg; maxLat += bufferDeg; minLng -= bufferDeg; maxLng += bufferDeg;
      polygons.push([[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]);
    });
    return polygons;
  }

  function fetchOSMRouteGeometry(provider, points, base, callback) {
    // Шаг 1: убеждаемся что у всех точек есть координаты
    // Шаг 1: убеждаемся что у всех точек есть координаты
    // Точки с координатами или из справочника — сразу; остальные — серийно через Nominatim (1.1с пауза)
    var needGeocodePts = [];
    var instantResolved = [];
    points.forEach(function(p) {
      if (p.lat != null && p.lng != null) { instantResolved.push(p); return; }
      if (p.o) {
        var obj = OBJ_MAP[p.o];
        if (obj && obj.lat && obj.lng) { p.lat = obj.lat; p.lng = obj.lng; instantResolved.push(p); return; }
      }
      needGeocodePts.push(p);
    });

    function proceedWithCoords(resolvedPoints) {
      // Шаг 2: фильтруем точки без координат, но используем центр Минска для них
      resolvedPoints.forEach(function(p) {
        if (p.lat == null || p.lng == null) {
          // Если геокодирование не удалось — ставим в центре Минска с малым смещением
          p.lat = 53.9023 + (Math.random() - 0.5) * 0.02;
          p.lng = 27.5619 + (Math.random() - 0.5) * 0.02;
          console.warn('Геокодирование не удалось для: ' + p.addr + ' — используется центр Минска');
        }
      });

      var validPoints = resolvedPoints;

      // Шаг 3: строим массив координат [lng,lat] — база → точки → база
      var coords = [[base.lng, base.lat]];
      validPoints.forEach(function(p) { coords.push([p.lng, p.lat]); });
      coords.push([base.lng, base.lat]);

      if (provider === 'valhalla') {
        var stadiaKey = (window.SP_CONFIG && SP_CONFIG.stadiaApiKey) || '';
        if (!stadiaKey) {
          console.warn('Stadia API ключ не задан (config.stadiaApiKey) — используется OSRM');
          fetchOSMRouteGeometry('osrm', resolvedPoints, base, callback);
          return;
        }
        var vApiUrl = (window.SP_CONFIG && SP_CONFIG.valhallaApiUrl) || 'https://api.stadiamaps.com';
        var vLocs = [{ lon: base.lng, lat: base.lat, type: 'break' }];
        validPoints.forEach(function(p) { vLocs.push({ lon: p.lng, lat: p.lat, type: 'break' }); });
        vLocs.push({ lon: base.lng, lat: base.lat, type: 'break' });
        var vBody = { costing: 'auto', shape_format: 'geojson', units: 'kilometers', locations: vLocs };
        var excludePolys = buildExcludePolygons();
        if (excludePolys.length) vBody.exclude_polygons = excludePolys;
        var vEndpoint = validPoints.length > 1 ? '/optimized_route/v1' : '/route/v1';
        fetch(vApiUrl + vEndpoint + '?api_key=' + stadiaKey, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vBody)
        }).then(function(r) {
          if (!r.ok) throw new Error('Stadia HTTP ' + r.status);
          return r.json();
        }).then(function(res) {
          if (!res || !res.trip) { callback({ ok: false, msg: 'Valhalla: нет trip' }); return; }
          var trip = res.trip;
          var totalKm = (trip.summary && trip.summary.length) ? trip.summary.length : 0;
          var totalMin = Math.round(((trip.summary && trip.summary.time) ? trip.summary.time : 0) / 60);
          var geom = [];
          (trip.legs || []).forEach(function(leg, li) {
            if (leg.shape && leg.shape.length) {
              leg.shape.forEach(function(c, ci) { if (li === 0 || ci > 0) geom.push(c); });
            }
          });
          var waypoints = [];
          if (res.trip.locations && res.trip.locations.length) {
            var outPos = {};
            res.trip.locations.forEach(function(loc, outIdx) { if (loc.original_index != null) outPos[loc.original_index] = outIdx; });
            for (var wi = 0; wi <= validPoints.length + 1; wi++) {
              waypoints.push({ waypoint_index: (outPos[wi] != null ? outPos[wi] : wi) });
            }
          }
          callback({ ok: true, geometry: geom, km: totalKm, min: totalMin, legs: trip.legs || [], waypoints: waypoints, engine: 'valhalla' });
        }).catch(function(e) { callback({ ok: false, msg: 'Stadia: ' + e.message }); });

      } else if (provider === 'osrm') {
        var manualClosures = ymState.roadClosures.filter(function(c) { return c.manual; });

        var tripCoords = coords.slice(0, -1);
        var coordStr = tripCoords.map(function(c) { return c.join(','); }).join(';');
        fetch('https://router.project-osrm.org/trip/v1/driving/' + coordStr +
          '?roundtrip=true&source=first&overview=full&geometries=geojson&steps=true')
          .then(function(r) { return r.json(); })
          .then(function(res) {
            if (!res || !res.trips || !res.trips[0]) { callback({ ok: false, msg: 'OSRM error' }); return; }
            var trip = res.trips[0];

            if (manualClosures.length === 0) {
              callback({ ok: true, geometry: trip.geometry.coordinates || [], km: trip.distance / 1000, min: Math.round(trip.duration / 60), legs: trip.legs || [], waypoints: res.waypoints || [] });
              return;
            }

            // Парсим оптимальный порядок
            var orderedPts = [];
            for (var wi = 1; wi < (res.waypoints || []).length; wi++) {
              var wp = res.waypoints[wi];
              if (wp && wp.waypoint_index != null && wp.waypoint_index > 0) orderedPts[wp.waypoint_index - 1] = validPoints[wi - 1];
            }
            orderedPts = orderedPts.filter(function(p) { return p; });
            if (orderedPts.length !== validPoints.length) orderedPts = validPoints.slice();

            // Проверяем проходит ли маршрут через закрытия
            var routeGeom = trip.geometry.coordinates || [];
            var viaPoints = [];
            // Центроид маршрута — чтобы выбрать СТОРОНУ объезда (наружу от маршрута)
            var rcLat = 0, rcLng = 0;
            for (var rg = 0; rg < routeGeom.length; rg++) { rcLat += routeGeom[rg][1]; rcLng += routeGeom[rg][0]; }
            var rcN = routeGeom.length || 1; rcLat /= rcN; rcLng /= rcN;

            manualClosures.forEach(function(cl) {
              var mnLat = Infinity, mxLat = -Infinity, mnLng = Infinity, mxLng = -Infinity;
              cl.latlngs.forEach(function(p) {
                if (p[0] < mnLat) mnLat = p[0]; if (p[0] > mxLat) mxLat = p[0];
                if (p[1] < mnLng) mnLng = p[1]; if (p[1] > mxLng) mxLng = p[1];
              });
              var buf = 0.0015; // ~150 м — шире обнаружение попадания
              mnLat -= buf; mxLat += buf; mnLng -= buf; mxLng += buf;
              var hit = false;
              for (var ri = 0; ri < routeGeom.length; ri++) {
                if (routeGeom[ri][1] >= mnLat && routeGeom[ri][1] <= mxLat && routeGeom[ri][0] >= mnLng && routeGeom[ri][0] <= mxLng) { hit = true; break; }
              }
              if (hit) {
                var mLat = 0, mLng = 0;
                cl.latlngs.forEach(function(p) { mLat += p[0]; mLng += p[1]; });
                mLat /= cl.latlngs.length; mLng /= cl.latlngs.length;
                var f = cl.latlngs[0], l = cl.latlngs[cl.latlngs.length - 1];
                var dx = l[0] - f[0], dy = l[1] - f[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
                var off = 0.009; // ~1 км перпендикулярно закрытию — OSRM вынужден объехать
                var pLng = -dy / len, pLat = dx / len; // перпендикуляр
                var candA = [mLng + pLng * off, mLat + pLat * off];
                var candB = [mLng - pLng * off, mLat - pLat * off];
                // выбираем сторону ДАЛЬШЕ от центроида маршрута (объезд наружу)
                var dA = (candA[0]-rcLng)*(candA[0]-rcLng) + (candA[1]-rcLat)*(candA[1]-rcLat);
                var dB = (candB[0]-rcLng)*(candB[0]-rcLng) + (candB[1]-rcLat)*(candB[1]-rcLat);
                viaPoints.push(dA > dB ? candA : candB);
              }
            });

            if (viaPoints.length === 0) {
              callback({ ok: true, geometry: trip.geometry.coordinates || [], km: trip.distance / 1000, min: Math.round(trip.duration / 60), legs: trip.legs || [], waypoints: res.waypoints || [] });
              return;
            }

            // Снапим via-points к дорогам и вставляем каждый рядом со своим закрытием
            Promise.all(viaPoints.map(function(vp) {
              return fetch('https://router.project-osrm.org/nearest/v1/driving/' + vp[0] + ',' + vp[1] + '?number=1')
                .then(function(r) { return r.json(); })
                .then(function(d) { return (d.waypoints && d.waypoints[0]) ? d.waypoints[0].location : vp; })
                .catch(function() { return vp; });
            })).then(function(snapped) {
              // Цепочка точек маршрута: база → p0 → ... → pN → база
              var chain = [[base.lng, base.lat]];
              orderedPts.forEach(function(p) { chain.push([p.lng, p.lat]); });
              chain.push([base.lng, base.lat]);
              // Для каждой объездной точки — ближайший сегмент цепочки
              var detours = snapped.map(function(vp) {
                var bestAfter = 0, bestDist = Infinity;
                for (var seg = 0; seg < chain.length - 1; seg++) {
                  var mx = (chain[seg][0] + chain[seg+1][0]) / 2;
                  var my = (chain[seg][1] + chain[seg+1][1]) / 2;
                  var dd = (mx - vp[0])*(mx - vp[0]) + (my - vp[1])*(my - vp[1]);
                  if (dd < bestDist) { bestDist = dd; bestAfter = seg; }
                }
                return { vp: vp, after: bestAfter };
              });
              // Собираем координаты, вставляя via-точки в нужные сегменты
              var routeCoords = [];
              for (var ci = 0; ci < chain.length; ci++) {
                routeCoords.push(chain[ci]);
                detours.forEach(function(d) { if (d.after === ci) routeCoords.push(d.vp); });
              }
              // Убираем подряд идущие дубликаты координат (иначе OSRM может ошибиться)
              var dedup = [];
              routeCoords.forEach(function(c) {
                var prev = dedup[dedup.length - 1];
                if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) dedup.push(c);
              });
              var rcStr = dedup.map(function(c) { return c.join(','); }).join(';');
              return fetch('https://router.project-osrm.org/route/v1/driving/' + rcStr + '?overview=full&geometries=geojson&steps=true');
            }).then(function(r) { return r.json(); }).then(function(res2) {
              if (res2 && res2.routes && res2.routes[0]) {
                var rt = res2.routes[0];
                var newGeom = rt.geometry.coordinates || [];
                // Проверяем: новый маршрут всё ещё через закрытие?
                var stillHit = false;
                manualClosures.forEach(function(cl) {
                  if (stillHit) return;
                  var cMn = Infinity, cMx = -Infinity, cMn2 = Infinity, cMx2 = -Infinity;
                  cl.latlngs.forEach(function(p) { if(p[0]<cMn)cMn=p[0]; if(p[0]>cMx)cMx=p[0]; if(p[1]<cMn2)cMn2=p[1]; if(p[1]>cMx2)cMx2=p[1]; });
                  cMn-=0.0015; cMx+=0.0015; cMn2-=0.0015; cMx2+=0.0015;
                  for (var gi = 0; gi < newGeom.length; gi++) {
                    if (newGeom[gi][1]>=cMn && newGeom[gi][1]<=cMx && newGeom[gi][0]>=cMn2 && newGeom[gi][0]<=cMx2) { stillHit = true; break; }
                  }
                });
                if (stillHit) {
                  // reroute не помог — возвращаем исходный (лучше короткий, чем крюк через закрытие)
                  callback({ ok: true, geometry: trip.geometry.coordinates || [], km: trip.distance / 1000, min: Math.round(trip.duration / 60), legs: trip.legs || [], waypoints: res.waypoints || [] });
                } else {
                  // reroute успешен — маршрут обходит закрытие
                  callback({ ok: true, geometry: newGeom, km: rt.distance / 1000, min: Math.round(rt.duration / 60), legs: rt.legs || [], waypoints: res.waypoints || [] });
                }
              } else {
                callback({ ok: true, geometry: trip.geometry.coordinates || [], km: trip.distance / 1000, min: Math.round(trip.duration / 60), legs: trip.legs || [], waypoints: res.waypoints || [] });
              }
            }).catch(function() {
              callback({ ok: true, geometry: trip.geometry.coordinates || [], km: trip.distance / 1000, min: Math.round(trip.duration / 60), legs: trip.legs || [], waypoints: res.waypoints || [] });
            });
          }).catch(function(e) { callback({ ok: false, msg: e.message }); });

      } else if (provider === 'graphhopper') {
        var ghKey = (window.SP_CONFIG && SP_CONFIG.graphhopperApiKey) || '';
        var ghPoints = coords.map(function(c) { return c[1] + ',' + c[0]; }); // lat,lng
        var ghUrl = 'https://graphhopper.com/api/1/route?' +
          ghPoints.map(function(p) { return 'point=' + encodeURIComponent(p); }).join('&') +
          '&profile=car&locale=ru&points_encoded=false&ch.disable=true&key=' + ghKey;
        fetch(ghUrl).then(function(r) { return r.json(); }).then(function(res) {
          if (res && res.paths && res.paths[0]) {
            var path = res.paths[0];
            callback({ ok: true, geometry: path.points.coordinates || [], km: path.distance / 1000, min: Math.round(path.time / 60000), legs: path.instructions || [] });
          } else callback({ ok: false, msg: res && res.message ? res.message : 'GH error' });
        }).catch(function(e) { callback({ ok: false, msg: e.message }); });

      } else if (provider === 'ors') {
        var orsKey = (window.SP_CONFIG && SP_CONFIG.orsApiKey) || '';
        var ap = buildAvoidPolygons();
        var orsBody = { coordinates: coords };
        if (ap.length) orsBody.options = { avoid_polygons: { type: 'MultiPolygon', coordinates: ap.map(function(r){ return [r]; }) } };
        fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
          method: 'POST',
          headers: { 'Authorization': orsKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(orsBody)
        }).then(function(r) { return r.json(); }).then(function(res) {
          if (res && res.features && res.features[0]) {
            var feat = res.features[0];
            var summary = feat.properties && feat.properties.summary ? feat.properties.summary : {};
            callback({ ok: true, geometry: feat.geometry.coordinates || [], km: (summary.distance || 0) / 1000, min: Math.round((summary.duration || 0) / 60), legs: feat.properties.segments || [] });
          } else callback({ ok: false, msg: res && res.error ? res.error.message : 'ORS error' });
        }).catch(function(e) { callback({ ok: false, msg: e.message }); });

      } else callback({ ok: false });
    }

    // Запуск: если есть точки без координат — геокодируем серийно (1.1с пауза), иначе сразу
    if (needGeocodePts.length > 0) {
      geocodeBatchSerial(needGeocodePts, function (p, c) {
        if (c) { p.lat = c.lat; p.lng = c.lng; }
      }).then(function () {
        proceedWithCoords(instantResolved.concat(needGeocodePts));
      });
    } else {
      proceedWithCoords(instantResolved);
    }
  }

  function buildRoute(noJam) {
    var pts = ymState.pts;
    var canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    if (!pts || pts.length < 1) { toast("warn", "Нет заданий на выбранный день."); return; }
    var base = currentBase();
    ymState.manualOrder = false;

    var tasks = pts.filter(function (p) { return p.addr && p.addr.trim() && p.addr !== "?"; });
    if (!tasks.length) { toast("warn", "В заданиях не указаны адреса."); return; }

    var prov = S.mapProvider || "osrm";
    var provName = prov === "google" ? "Google Maps" : prov === "valhalla" ? "Valhalla" : prov === "osrm" ? "OpenStreetMap" : prov === "graphhopper" ? "GraphHopper" : prov === "ors" ? "OpenRouteService" : prov === "osm" ? "OpenStreetMap" : prov === "2gis" ? "2ГИС" : "Яндекс.Карт";

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
      // === Google Maps: реальная карта через JS API + DirectionsRenderer ===
      canvas.style.position = 'relative';
      canvas.innerHTML = '<div id="gmap-canvas" style="position:absolute;inset:0;"></div>';

      // Загружаем Google Maps API если ещё не загружен
      function gmapsCallback() {
        var map = new window.google.maps.Map(document.getElementById('gmap-canvas'), {
          center: { lat: 53.9023, lng: 27.5619 },
          zoom: 12,
          mapTypeControl: false,
          streetViewControl: false
        });

        var directionsService = new window.google.maps.DirectionsService();
        var directionsRenderer = new window.google.maps.DirectionsRenderer({
          draggable: false,
          suppressMarkers: false,
          suppressInfoWindows: false
        });
        directionsRenderer.setMap(map);

        var originStr = base.name.indexOf("Минск") !== -1 ? base.name : "Минск, " + base.name;
        var wps = [];
        for (var i = 0; i < ordered.length; i++) {
          var a = ordered[i].addr;
          wps.push({ location: a.indexOf("Минск") !== -1 ? a : "Минск, " + a, stopover: true });
        }

        directionsService.route({
          origin: originStr,
          destination: originStr,
          waypoints: wps,
          optimizeWaypoints: false,
          travelMode: window.google.maps.TravelMode.DRIVING,
          drivingOptions: { departureTime: new Date(), trafficModel: window.google.maps.TrafficModel.BEST_GUESS }
        }, function(res, status) {
          if (status === 'OK' && res) {
            directionsRenderer.setDirections(res);

            // Вычисляем суммарные показатели из API ответа
            var legs = res.routes[0].legs;
            var totalMeters = 0, totalSec = 0, totalSecTraffic = 0;
            for (var li = 0; li < legs.length; li++) {
              totalMeters += legs[li].distance ? legs[li].distance.value : 0;
              totalSec += legs[li].duration ? legs[li].duration.value : 0;
              if (legs[li].duration_in_traffic) totalSecTraffic += legs[li].duration_in_traffic.value;
            }
            var totalKm = totalMeters / 1000;
            var freeMin = Math.max(1, Math.round(totalSec / 60));
            var jamsMin = totalSecTraffic > 0 ? Math.max(1, Math.round(totalSecTraffic / 60)) : freeMin;

            // Применяем данные к карточкам задач
            ordered.forEach(function(p, pi) {
              if (legs[pi]) {
                var km = legs[pi].distance ? legs[pi].distance.value / 1000 : 0;
                var sec = legs[pi].duration_in_traffic ? legs[pi].duration_in_traffic.value : (legs[pi].duration ? legs[pi].duration.value : 0);
                var min = Math.max(1, Math.round(sec / 60));
                p.travelKm = km;
                p.travelKmText = km.toFixed(1).replace('.', ',') + ' км';
                p.travelMin = min;
                p.travelText = fmtDuration(min);
                var st = findTask(p.id);
                if (st) {
                  st.travelKm = km; st.travelKmText = p.travelKmText; st.travelMin = min; st.travelText = p.travelText;
                  if (TASKS_DB) TASKS_DB.updateTask(st.id, st);
                }
              }
            });

            clearTimeout(fallbackTimeoutId);
            updateDayListCards(ordered);
            refreshMapCards(ordered);

            // Данные маршрута — из Directions API
            setRouteInfo({ km: totalKm, jamsMin: jamsMin, freeMin: freeMin, count: ordered.length });
            toast("ok", "✓ Маршрут оптимизирован для Google Maps! Нумерация и карточки обновлены.");
            var dirUrl = buildGoogleDirUrl(routeItems);
            var lp = document.createElement('div');
            lp.className = 'route-link-panel';
            lp.innerHTML = '<span>🚩 <b>База</b> → ' + ordered.length + ' объектов (<b>Google Maps</b>) → <b>База</b></span><div class="route-actions"><a class="btn sm primary" target="_blank" rel="noopener" href="' + dirUrl + '" style="background:#10b981;border-color:#10b981;">↗ Открыть в Google Maps</a></div>';
            canvas.appendChild(lp);
          } else {
            clearTimeout(fallbackTimeoutId);
            updateFallbackRouteInfo(ordered);
            renderProviderFrame("google", routeItems);
            toast("warn", "⚠ Google Maps не смог построить маршрут. Использованы приблизительные данные.");
          }
        });
      }

      // Динамическая загрузка Google Maps JS API
      if (window.google && window.google.maps) {
        gmapsCallback();
      } else {
        var s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?libraries=places&callback=__gmapsInit';
        window.__gmapsInit = function() { gmapsCallback(); };
        s.onerror = function() {
          clearTimeout(fallbackTimeoutId);
          updateFallbackRouteInfo(ordered);
          renderProviderFrame("google", routeItems);
          toast("err", "⚠ Не удалось загрузить Google Maps API. Проверьте API-ключ.");
        };
        document.head.appendChild(s);
      }
    } else if (prov === "osrm" || prov === "graphhopper" || prov === "ors" || prov === "valhalla") {
      var provName = prov === "valhalla" ? "Valhalla" : prov === "osrm" ? "OpenStreetMap" : prov === "graphhopper" ? "GraphHopper" : "OpenRouteService";
      setRouteInfo({ km: 0, count: ordered.length, building: true });
      toast("ok", "⏳ Оптимизирую маршрут для " + provName + "…");
      if (prov === 'valhalla' && !(window.SP_CONFIG && SP_CONFIG.stadiaApiKey)) {
        toast("warn", "⚠ Ключ Stadia Maps не задан (config.stadiaApiKey). Расчёт через OSRM — объезд закрытий НЕ гарантируется. Для объезда: бесплатный ключ на stadiamaps.com → вставить в config.js.");
      }
      updateDayListCards(ordered);
      refreshMapCards(ordered);
      // Яндекс.Карты в фоне находят координаты по адресам заданий → передаём их в OpenStreetMap (OSRM)
      toast("ok", "📍 Яндекс.Карты определяют координаты адресов, затем " + provName + " строит маршрут…");
      geocodePointsViaYandex(ordered).then(function () {
      fetchOSMRouteGeometry(prov, ordered, base, function(result) {
        clearTimeout(fallbackTimeoutId);
        if (result.ok && result.geometry.length > 0) {
          ensureLeaflet(function() {
            var canvas2 = document.getElementById("map-canvas");
            if (!canvas2 || !ymState.leafletMap) return;
            if (ymState.leafletRouteLayer) { try { ymState.leafletRouteLayer.remove(); } catch(e) {} }
            var latlngs = result.geometry.map(function(c) { return [c[1], c[0]]; });
            ymState.leafletRouteLayer = window.L.polyline(latlngs, { color: '#2563eb', weight: 5, opacity: 0.8 }).addTo(ymState.leafletMap);
            ymState.leafletMap.fitBounds(ymState.leafletRouteLayer.getBounds(), { padding: [40, 40] });
            addDirectionArrows(ymState.leafletMap, latlngs);
            var oldPanel = canvas2.querySelector('.route-link-panel');
            if (oldPanel) oldPanel.remove();
            var lp = document.createElement('div');
            lp.className = 'route-link-panel';
            lp.innerHTML = '<span>🚩 <b>База</b> → ' + ordered.length + ' объектов (<b>' + provName + '</b>) → <b>База</b></span><div class="route-actions"><label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#e2e8f0;cursor:pointer"><input type="checkbox" id="cb-car-anim" style="width:15px;height:15px;cursor:pointer"> 🚗 Авто</label><button id="btn-fullscreen-route" class="btn sm primary" style="background:#10b981;border-color:#10b981;">↗ Открыть на весь экран</button></div>';
            canvas2.appendChild(lp);
            var fsMarkers = [{ lat: base.lat, lng: base.lng, addr: base.name, mcol: '#0f2740', label: 'Б' }];
            ordered.forEach(function(p, i) { fsMarkers.push({ lat: p.lat, lng: p.lng, addr: p.addr, mcol: p.mcol, label: String(i + 1) }); });
            fsMarkers.push({ lat: base.lat, lng: base.lng, addr: base.name, mcol: '#0f2740', label: 'Б' });
            var btnFs = document.getElementById('btn-fullscreen-route');
            if (btnFs) btnFs.addEventListener('click', function() { openRouteFullscreen(fsMarkers, latlngs); });
          });
          if ((prov === 'osrm' || prov === 'valhalla') && result.waypoints && result.waypoints.length >= ordered.length + 1) {
            var wpOrder = [];
            for (var wi = 1; wi <= ordered.length; wi++) {
              if (result.waypoints[wi] && result.waypoints[wi].waypoint_index != null) {
                wpOrder.push({ task: ordered[wi - 1], pos: result.waypoints[wi].waypoint_index });
              }
            }
            if (wpOrder.length === ordered.length) {
              wpOrder.sort(function (a, b) { return a.pos - b.pos; });
              ordered = wpOrder.map(function (x) { return x.task; });
              routeItems = [base];
              ordered.forEach(function (p) { routeItems.push(p); });
              routeItems.push(base);
            }
          }
          if (result.legs && result.legs.length > 0) {
            var lastLegRetMin = 0, lastLegRetKm = 0;
            ordered.forEach(function(p, idx) {
              if (idx < result.legs.length) {
                var leg = result.legs[idx];
                var legKm, legSec;
                if (prov === 'graphhopper') { legKm = result.km / ordered.length; legSec = result.min * 60 / ordered.length; }
                else if (prov === 'valhalla') { var ls = leg.summary || {}; legKm = ls.length || 0; legSec = ls.time || 0; }
                else { legKm = (leg.distance || 0) / 1000; legSec = leg.duration || 0; }
                p.travelKm = legKm; p.travelKmText = legKm.toFixed(1).replace('.', ',') + ' км';
                p.travelMin = Math.max(1, Math.round(legSec / 60)); p.travelText = fmtDuration(p.travelMin);
                var st = findTask(p.id);
                if (st) { st.travelKm = p.travelKm; st.travelKmText = p.travelKmText; st.travelMin = p.travelMin; st.travelText = p.travelText; if (TASKS_DB) TASKS_DB.updateTask(st.id, st); }
              }
            });
            if (result.legs.length > ordered.length) {
              var retLeg = result.legs[ordered.length];
              var retKm = prov === 'valhalla' ? ((retLeg.summary || {}).length || 0) : ((retLeg.distance || 0) / 1000);
              var retSec = prov === 'valhalla' ? ((retLeg.summary || {}).time || 0) : (retLeg.duration || 0);
              var retMin = Math.max(1, Math.round(retSec / 60));
              lastLegRetMin = retMin; lastLegRetKm = retKm;
              var lastTask = ordered.length ? ordered[ordered.length - 1] : null;
              var bcEl = document.getElementById('base-return-info');
              if (bcEl) {
                var lastAddr = lastTask ? (lastTask.addr || '?') : '';
                if (lastAddr.length > 28) lastAddr = lastAddr.substring(0, 28) + '…';
                bcEl.innerHTML = '🛣 От «' + esc(lastAddr) + '» до базы: <b style="color:#fff">' + fmtDuration(retMin) + '</b> · ' + retKm.toFixed(1).replace('.', ',') + ' км';
              }
            }
          }
          updateDayListCards(ordered);
          refreshMapCards(ordered);
          redrawOptimizedMarkers(ordered);
          var rawMin = result.min;
          var addTen = prov === 'osrm' ? 10 : 0;
          var jamsMin = rawMin + addTen;
          var freeMin = Math.round(rawMin * 0.85) + addTen;
          setRouteInfo({ km: result.km, jamsMin: jamsMin, freeMin: freeMin, count: ordered.length });
          if (prov === 'osrm' || prov === 'valhalla') {
            var savedRT = saveRouteTime(S.mapMaster, S.mapOff, jamsMin, result.km, lastLegRetMin, lastLegRetKm);
            toast("ok", "✓ " + provName + ": " + result.km.toFixed(1).replace('.', ',') + " км, " + jamsMin + " мин." + (savedRT ? ' · время записано в планирование' : ''));
          } else {
            toast("ok", "✓ " + provName + ": " + result.km.toFixed(1).replace('.', ',') + " км, " + jamsMin + " мин.");
          }
        } else {
          updateFallbackRouteInfo(ordered);
          toast("warn", "⚠ " + provName + ": " + (result.msg || "ошибка") + ". Используются приблизительные данные.");
        }
      });
      }); // конец geocodePointsViaYandex → координаты Яндекса переданы в OpenStreetMap
    } else {
      // === Яндекс.Карты: оптимизация через OSRM + отображение через iframe ===
      fetchOSMRouteGeometry('osrm', ordered, base, function(result) {
        clearTimeout(fallbackTimeoutId);
        if (result.ok && result.geometry.length > 0) {
          if (result.waypoints && result.waypoints.length >= ordered.length + 1) {
            var wpOrder = [];
            for (var wi = 1; wi <= ordered.length; wi++) {
              if (result.waypoints[wi] && result.waypoints[wi].waypoint_index != null) {
                wpOrder.push({ task: ordered[wi - 1], pos: result.waypoints[wi].waypoint_index });
              }
            }
            if (wpOrder.length === ordered.length) {
              wpOrder.sort(function (a, b) { return a.pos - b.pos; });
              ordered = wpOrder.map(function (x) { return x.task; });
              routeItems = [base];
              ordered.forEach(function (p) { routeItems.push(p); });
              routeItems.push(base);
            }
          }
          if (result.legs && result.legs.length > 0) {
            ordered.forEach(function(p, idx) {
              if (idx < result.legs.length) {
                var leg = result.legs[idx];
                var legKm = (leg.distance || 0) / 1000;
                var legSec = leg.duration || 0;
                p.travelKm = legKm; p.travelKmText = legKm.toFixed(1).replace('.', ',') + ' км';
                p.travelMin = Math.max(1, Math.round(legSec / 60)); p.travelText = fmtDuration(p.travelMin);
                var st = findTask(p.id);
                if (st) { st.travelKm = p.travelKm; st.travelKmText = p.travelKmText; st.travelMin = p.travelMin; st.travelText = p.travelText; if (TASKS_DB) TASKS_DB.updateTask(st.id, st); }
              }
            });
          }
          updateDayListCards(ordered);
          refreshMapCards(ordered);
          var jamsMin = result.min + 10;
          var freeMin = Math.round(result.min * 0.85) + 10;
          setRouteInfo({ km: result.km, jamsMin: jamsMin, freeMin: freeMin, count: ordered.length });
          saveRouteTime(S.mapMaster, S.mapOff, jamsMin, result.km);
          renderProviderFrame("yandex", routeItems, noJam);
          toast("ok", "✓ Яндекс.Карты: " + result.km.toFixed(1).replace('.', ',') + " км, " + jamsMin + " мин. (расчёт OSRM)");
        } else {
          updateFallbackRouteInfo(ordered);
          renderProviderFrame("yandex", routeItems, noJam);
          toast("warn", "⚠ " + (result.msg || "ошибка") + ". Использованы приблизительные данные.");
        }
      });
    }

    function renderProviderFrame(pr, items, nj) {
      var url = "", dirUrl = "", name = "";
      if (pr === "google") { url = buildGoogleWidgetUrl(items); dirUrl = buildGoogleDirUrl(items); name = "Google Maps"; }
      else if (pr === "osm") { url = buildOsmWidgetUrl(items); dirUrl = buildOsmDirUrl(items); name = "OpenStreetMap"; }
      else if (pr === "2gis") { url = build2GisWidgetUrl(items); dirUrl = build2GisDirUrl(items); name = "2ГИС"; }
      else { url = buildYandexWidgetUrl(items, nj); dirUrl = buildYandexDirUrl(items, nj); name = "Яндекс.Карты"; }
      var panelActions = dirUrl ? "<div class='route-actions'><a class='btn sm primary' target='_blank' rel='noopener' href='" + dirUrl + "' style='background:#10b981;border-color:#10b981;'>↗ Открыть в " + name + "</a></div>" : "";
      canvas.style.position = "relative";
      canvas.innerHTML = "<iframe class='route-frame' src='" + url + "' allowfullscreen loading='lazy' title='Маршрут (" + name + ")'></iframe><div class='route-link-panel'><span>🚩 <b>База</b> → " + (items.length - 2) + " объектов (<b>" + name + "</b>) → <b>База</b></span>" + panelActions + "</div>";
    }
  }

  function buildYandexRoute(n) { buildRoute(n); }

  function extractRouteDataFromDOM(container, callback) {
    var attempts = 0;
    var maxAttempts = 15; // 15 попыток по 500мс = 7.5 сек максимум

    function tryExtract() {
      attempts++;
      // Ищем элементы с данными маршрута внутри контейнера карты
      var allElements = container.querySelectorAll('*');
      var kmVal = null, jamsText = null, freeText = null;

      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var text = (el.textContent || '').trim();
        if (!text || text.length > 100) continue;

        // Расстояние: "15,2 км" или "15.2 км"
        if (kmVal === null) {
          var kmMatch = text.match(/^([\d.,]+)\s*км$/i);
          if (kmMatch) {
            kmVal = parseFloat(kmMatch[1].replace(',', '.'));
          }
        }

        // Время: "42 мин", "1 ч 15 мин", "1 ч"
        if (jamsText === null && text.match(/^[\d]+\s*(ч|min|мин)/i) && !text.match(/без/i)) {
          // Проверяем что это не подпись
          if (text.match(/^\d/) && (text.indexOf('мин') !== -1 || text.indexOf('ч') !== -1)) {
            if (jamsText === null) jamsText = text;
          }
        }

        // Время без пробок: обычно рядом или с пометкой
        if (freeText === null && text.match(/^[\d]+\s*(ч|min|мин)/i) && !text.match(/без/i)) {
          if (jamsText !== null && text !== jamsText && freeText === null) {
            freeText = text;
          }
        }
      }

      // Если не нашли через точные селекторы — ищем по текстовому содержимому
      if (kmVal === null) {
        var fullText = container.textContent || '';
        var kmMatch2 = fullText.match(/([\d.,]+)\s*км/i);
        if (kmMatch2) kmVal = parseFloat(kmMatch2[1].replace(',', '.'));
      }

      if (jamsText === null) {
        var fullText2 = container.textContent || '';
        // Ищем паттерны времени
        var timeMatches = fullText2.match(/(\d+)\s*(?:ч\s*)?(\d+)?\s*мин/g);
        if (timeMatches && timeMatches.length > 0) {
          jamsText = timeMatches[0];
          if (timeMatches.length > 1) freeText = timeMatches[1];
        }
        // Или формат "1 ч" без минут
        var hourMatches = fullText2.match(/(\d+)\s*ч(?!\s*\d)/g);
        if (hourMatches && jamsText === null) {
          jamsText = hourMatches[0];
          if (hourMatches.length > 1) freeText = hourMatches[1];
        }
      }

      if (kmVal !== null && kmVal > 0) {
        // Парсим минуты из текста
        function parseMinutes(txt) {
          if (!txt) return 0;
          var h = txt.match(/(\d+)\s*ч/);
          var m = txt.match(/(\d+)\s*мин/);
          var total = 0;
          if (h) total += parseInt(h[1], 10) * 60;
          if (m) total += parseInt(m[1], 10);
          return total || Math.max(1, Math.round(kmVal / 30 * 60));
        }

        var jamsMin = parseMinutes(jamsText);
        var freeMin = freeText ? parseMinutes(freeText) : Math.round(jamsMin * 0.75);

        console.log('📊 Данные маршрута из DOM виджета Яндекс.Карт:');
        console.log('   📍 Расстояние:', kmVal.toFixed(2), 'км');
        console.log('   🚗 Время с пробками:', jamsMin, 'мин (' + jamsText + ')');
        console.log('   🛣️ Время без пробок:', freeMin, 'мин (' + (freeText || 'расчётно') + ')');

        callback({ km: kmVal, jamsMin: jamsMin, freeMin: freeMin });
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryExtract, 500);
      } else {
        console.warn('⚠ Данные маршрута не найдены в DOM виджета');
        callback(null);
      }
    }

    // Небольшая задержка чтобы DOM успел отрисоваться
    setTimeout(tryExtract, 800);
  }

  function extractYandexStats(route) {
    if (!route) return null;
    var totalKm = 0, jamsMin = 0, freeMin = 0;
    try {
      var activeRoute = null;
      // Способ 1: через getActiveRoute (если выбран)
      if (typeof route.getActiveRoute === 'function') {
        activeRoute = route.getActiveRoute();
      }
      // Способ 2: через model.getRoutes() — основной способ по API 2.1
      if (!activeRoute && route.model && typeof route.model.getRoutes === 'function') {
        var routes = route.model.getRoutes();
        if (routes && routes.length > 0) activeRoute = routes[0];
      }

      if (activeRoute && activeRoute.properties) {
        var props = activeRoute.properties;

        // Расстояние в метрах → км
        var distVal = props.get('distance');
        if (distVal != null) {
          var distMeters = (typeof distVal === 'object' && distVal.value !== undefined) ? distVal.value : (typeof distVal === 'number' ? distVal : parseFloat(distVal));
          totalKm = distMeters / 1000;
        }

        // Время с пробками (time) в секундах → минуты
        var timeVal = props.get('time');
        if (timeVal != null) {
          var timeSec = (typeof timeVal === 'object' && timeVal.value !== undefined) ? timeVal.value : (typeof timeVal === 'number' ? timeVal : parseFloat(timeVal));
          jamsMin = Math.max(1, Math.round(timeSec / 60));
        }

        // Время без пробок (timeWithoutTraffic) в секундах → минуты
        var timeNoTrafficVal = props.get('timeWithoutTraffic');
        if (timeNoTrafficVal != null) {
          var timeNoTrafficSec = (typeof timeNoTrafficVal === 'object' && timeNoTrafficVal.value !== undefined) ? timeNoTrafficVal.value : (typeof timeNoTrafficVal === 'number' ? timeNoTrafficVal : parseFloat(timeNoTrafficVal));
          freeMin = Math.max(1, Math.round(timeNoTrafficSec / 60));
        }
      }

      // Fallback: если свойства не найдены, пробуем getLength/getJamsTime/getTime
      if (totalKm === 0 && activeRoute && typeof activeRoute.getLength === 'function') {
        totalKm = activeRoute.getLength() / 1000;
      }
      if (jamsMin === 0 && activeRoute && typeof activeRoute.getJamsTime === 'function') {
        var jt = activeRoute.getJamsTime();
        if (jt > 0) jamsMin = Math.max(1, Math.round(jt / 60));
      }
      if (freeMin === 0 && activeRoute && typeof activeRoute.getTime === 'function') {
        var ft = activeRoute.getTime();
        if (ft > 0) freeMin = Math.max(1, Math.round(ft / 60));
      }
    } catch(e) {
      console.error('extractYandexStats error:', e);
    }

    if (jamsMin === 0 && freeMin > 0) jamsMin = freeMin;
    if (freeMin === 0 && jamsMin > 0) freeMin = jamsMin;

    console.log('📊 Данные маршрута из API Яндекс.Карт:');
    console.log('   Расстояние:', totalKm.toFixed(2), 'км')
    console.log('   Время с пробками:', jamsMin, 'мин')
    console.log('   Время без пробок:', freeMin, 'мин')

    if (totalKm > 0) {
      return { km: totalKm, jamsMin: jamsMin, freeMin: freeMin };
    }
    return null;
  }

  function getMultiRouteStatsAsync(route, callback) {
    // Сразу пробуем извлечь
    var stats = extractYandexStats(route);
    if (stats && stats.km > 0) {
      callback(stats);
      return;
    }
    // Если не получилось — ждём событие requestsuccess на модели
    try {
      var handler = function() {
        var s = extractYandexStats(route);
        if (s && s.km > 0) {
          callback(s);
          // Удаляем обработчик после первого успешного вызова
          try { route.model.events.remove('requestsuccess', handler); } catch(e) {}
        }
      };
      if (route && route.model && route.model.events) {
        route.model.events.add('requestsuccess', handler);
      } else if (route && route.events) {
        route.events.add('requestsuccess', handler);
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
    // Неактивные (выключенные кликом) задания остаются в списке серыми
    var inactive = (ymState.inactivePts && ymState.inactivePts.length) ? ymState.inactivePts : [];
    if ((!pts || !pts.length) && !inactive.length) {
      mlist.innerHTML = "<div class='empty'>На этот день заданий нет</div>";
      return;
    }
    var html = "";
    if (pts && pts.length) {
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
    // Неактивные задания — серые, без номера и маршрута; клик включает обратно
    inactive.forEach(function (p) {
      html += "<div class='mtask' data-mid='" + p.id + "' draggable='true' style='opacity:.5;'>" +
        "<div class='mtask-grip' style='opacity:.5'>" + IC.grip + "</div>" +
        "<div class='pin' style='background:#94a3b8;color:#fff'>○</div>" +
        "<div style='flex:1;min-width:0'>" +
          "<div style='font-weight:700;color:var(--muted);font-size:12.5px;margin-bottom:3px'>📍 " + esc(p.addr) + "</div>" +
          "<div style='font-size:11.5px;color:var(--muted);margin-bottom:2px'>🔧 " + esc(p.work) + "</div>" +
          "<div style='font-size:11.5px;color:var(--muted);'>⏸ Не в маршруте — нажмите, чтобы включить</div>" +
        "</div></div>";
    });
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
  // Расчёт времени в пути по дистанции для Минска (средняя скорость ~27 км/ч)
  function calculateYandexMinskTime(km, withJams) {
    var speed = withJams ? 22 : 30; // км/ч: с пробками / без
    return Math.max(1, Math.round((km / speed) * 60));
  }

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

  // Открывает маршрут в новой вкладке на весь экран (Leaflet + MapTiler, подписи на русском).
  // markers — [{lat,lng,addr,mcol,label}], routeLatLngs — [[lat,lng],...] геометрия маршрута.
  // 🏎 «Дать газу»: 3D-вождение автомобиля по улицам Минска (MapLibre GL + MapTiler 3D + Three.js).
  // Стиль максимально «под Яндекс», масштаб 1:1. GLB-модель авто подхватывается автоматически (car.glb рядом с index.html).
  // 🏎 «Дать газу»: открывает статическую 3D-сцену drive3d.html (та же папка → car.glb грузится надёжно).
  function openDrive3D() {
    var base = currentBase();
    var key = (window.SP_CONFIG && SP_CONFIG.maptilerApiKey) || '';
    var url = 'drive3d.html?lat=' + encodeURIComponent(base.lat) + '&lng=' + encodeURIComponent(base.lng) + '&key=' + encodeURIComponent(key);
    var w = window.open(url, '_blank');
    if (!w) { toast('err', 'Разрешите всплывающие окна для «Дать газу»'); }
  }

  function openRouteFullscreen(markers, routeLatLngs) {
    var key = (window.SP_CONFIG && SP_CONFIG.maptilerApiKey) || '';
    var mkData = markers.map(function(m) {
      return { lat: m.lat, lng: m.lng, addr: m.addr || '', mcol: m.mcol || '#2563eb', label: m.label || '' };
    });
    var routeData = routeLatLngs || [];

    // Генерируем HTML через Blob — нет проблем с экранированием </script>
    var html = '<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<title>Маршрут · SmartPlan</title>\n' +
      '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>\n' +
      '<link rel="stylesheet" href="https://cdn.maptiler.com/maptiler-sdk-js/v1.1.2/maptiler-sdk.css"/>\n' +
      '<style>\n' +
      'html,body{margin:0;padding:0;height:100%;overflow:hidden;font-family:Segoe UI,Roboto,sans-serif}\n' +
      '#map{position:absolute;inset:0}\n' +
      '.leaflet-control-zoom{border:none!important;box-shadow:0 2px 8px rgba(0,0,0,.15)!important}\n' +
      '.leaflet-control-zoom a{background:#fff!important;color:#1f2937!important;border:none!important}#speed-panel{position:absolute;top:12px;right:12px;z-index:1500;background:rgba(15,39,64,.92);color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);font-size:12px;min-width:180px;font-family:inherit}#speed-panel .sp-title{font-weight:700;margin-bottom:7px;display:flex;align-items:center;justify-content:space-between;gap:6px}#speed-panel .sp-btns{display:flex;gap:4px;margin-bottom:8px}#speed-panel .sp-btn{flex:1;padding:5px 0;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit}#speed-panel .sp-btn:hover{background:rgba(255,255,255,.18)}#speed-panel .sp-btn.active{background:#2563eb;border-color:#2563eb}#speed-panel input[type=range]{width:100%;cursor:pointer;accent-color:#38bdf8;margin:2px 0}#speed-panel .sp-val{text-align:center;font-size:11px;color:#cbd5e1;margin-top:3px}\n' +
      '</style>\n</head>\n<body>\n<div id="map"></div><div id="speed-panel"><div class="sp-title">🚗 Скорость<button id="sp-toggle" class="sp-btn active" style="flex:none;padding:3px 9px;margin-left:6px">⏸</button></div><div class="sp-btns"><button class="sp-btn" data-mult="0.5">0.5×</button><button class="sp-btn active" data-mult="1">1×</button><button class="sp-btn" data-mult="2">2×</button><button class="sp-btn" data-mult="5">5×</button><button class="sp-btn" data-mult="10">10×</button></div><input type="range" id="sp-range" min="0" max="0.04" step="0.0005" value="0.004"><div class="sp-val" id="sp-val">×1,0</div></div>\n' +
      '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></scr' + 'ipt>\n' +
      '<script src="https://cdn.maptiler.com/maptiler-sdk-js/v1.1.2/maptiler-sdk.umd.js"></scr' + 'ipt>\n' +
      '<script src="https://cdn.maptiler.com/leaflet-maptilersdk/v1.0.0/leaflet-maptilersdk.js"></scr' + 'ipt>\n' +
      '<scr' + 'ipt>\n' +
      'var MK = ' + JSON.stringify(mkData) + ';\n' +
      'var RT = ' + JSON.stringify(routeData) + ';\n' +
      'var KEY = ' + JSON.stringify(key) + ';\n' +
      'var CAR_ON = ' + (document.getElementById('cb-car-anim') && document.getElementById('cb-car-anim').checked ? 'true' : 'false') + ';\n' +
      'var CAR_IMG = ' + JSON.stringify("data:image/png;base64,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") + ';\n' +
      '\n' +
      'var BASE_SPEED=0.004;window.SPEED=BASE_SPEED;window.CAR_PAUSED=false;(function(){if(!window.CAR_ON){var _sp=document.getElementById("speed-panel");if(_sp)_sp.style.display="none";return;}var rng=document.getElementById("sp-range"),val=document.getElementById("sp-val"),btns=document.querySelectorAll("#speed-panel .sp-btn[data-mult]"),tg=document.getElementById("sp-toggle");function lbl(){if(val)val.textContent="\u00d7"+(window.SPEED/BASE_SPEED).toFixed(1).replace(".",",");}function setA(m){btns.forEach(function(b){b.classList.toggle("active",Math.abs(parseFloat(b.getAttribute("data-mult"))-m)<0.001);});}function setS(s,fb){window.SPEED=s;if(rng)rng.value=s;lbl();if(!fb)setA(s/BASE_SPEED);}if(rng)rng.addEventListener("input",function(){setS(parseFloat(rng.value),false);});btns.forEach(function(b){b.addEventListener("click",function(){var m=parseFloat(b.getAttribute("data-mult"));setS(BASE_SPEED*m,true);setA(m);});});if(tg){tg.addEventListener("click",function(){window.CAR_PAUSED=!window.CAR_PAUSED;tg.textContent=window.CAR_PAUSED?"\u25b6":"\u23f8";tg.classList.toggle("active",!window.CAR_PAUSED);});}})();function start() {\n' +
      '  if (!window.L || !window.maptilersdk || !L.maptilerLayer) { setTimeout(start, 150); return; }\n' +
      '  var map = L.map("map", {attributionControl: false, zoomControl: false, center: [53.9023, 27.5619], zoom: 13});\n' +
      '  L.control.zoom({position: "bottomright"}).addTo(map);\n' +
      '\n' +
      '  function drawAll() {\n' +
      '    // Линия маршрута\n' +
      '    if (RT && RT.length >= 2) {\n' +
      '      L.polyline(RT, {color: "#2563eb", weight: 5, opacity: 0.8}).addTo(map);\n' +
      '      addArrows(RT);\n' +
      '      map.fitBounds(L.latLngBounds(RT), {padding: [50, 50]});\n' +
      '    }\n' +
      '    // Маркеры\n' +
      '    MK.forEach(function(m, i) {\n' +
      '      var isBase = (i === 0 || i === MK.length - 1);\n' +
      '      var h = isBase\n' +
      '        ? \'<div style="font-size:28px;line-height:1">\uD83D\uDEA9</div>\'\n' +
      '        : \'<div style="background:\' + m.mcol + \';color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)">\' + m.label + \'</div>\';\n' +
      '      L.marker([m.lat, m.lng], {icon: L.divIcon({html: h, className: "", iconSize: [28, 28], iconAnchor: [14, 14]})})\n' +
      '        .addTo(map).bindPopup("<b>" + (m.addr || "") + "</b>");\n' +
      '    });\n' +
      '    setTimeout(function() { map.invalidateSize(); }, 300);\n' +
      '    startCar();\n' +
      '  }\n' +
      '\n' +
      '  // Запуск анимации автомобиля (если чекбокс был включён)\n' +
      '  function startCar() {\n' +
      '    if (!window.CAR_ON || !RT || RT.length < 2) return;\n' +
      '    var carIcon = L.divIcon({\n' +
      '      html: \'<div style="position:relative;line-height:0;">\' +\n' +
      '        \'<div style="position:absolute;top:-28px;left:50%;transform:translateX(-50%);background:#0f2740;color:#fff;font-size:17px;font-weight:800;padding:10px 10px;border-radius:3px;white-space:nowrap;z-index:2;">МИНГАЗ</div>\' +\n' +
      '        \'<img src="\' + CAR_IMG + \'" style="width:32px;height:32px;object-fit:contain;transform-origin:center;filter:drop-shadow(0 3px 5px rgba(0,0,0,.6));"/>\' +\n' +
      '        \'</div>\',\n' +
      '      className: "", iconSize: [32, 32], iconAnchor: [16, 16]\n' +
      '    });\n' +
      '    var carMarker = L.marker([RT[0][0], RT[0][1]], {icon: carIcon, zIndexOffset: 2000}).addTo(map);\n' +
      '    var segIdx = 0, frac = 0;\n' +
      '    function animate() {if(window.CAR_PAUSED){requestAnimationFrame(animate);return;}\n' +
      '      if (segIdx >= RT.length - 1) { segIdx = 0; frac = 0; }\n' +
      '      var a = RT[segIdx], b = RT[segIdx + 1];\n' +
      '      frac += window.SPEED;\n' +
      '      if (frac >= 1) { frac = 0; segIdx++; if (segIdx >= RT.length - 1) segIdx = 0; a = RT[segIdx]; b = RT[segIdx + 1]; }\n' +
      '      var lat = a[0] + (b[0] - a[0]) * frac;\n' +
      '      var lng = a[1] + (b[1] - a[1]) * frac;\n' +
      '      var bearing = calcBrg(a[0], a[1], b[0], b[1]);\n' +
      '      var el = carMarker.getElement();\n' +
      '      carMarker.setLatLng([lat, lng]);\n' +
      '      if (el) { var img = el.querySelector("img"); if (img) img.style.transform = "rotate(" + bearing + "deg)"; }\n' +
      '      requestAnimationFrame(animate);\n' +
      '    }\n' +
      '    animate();\n' +
      '  }\n' +
      '\n' +
      '  function calcBrg(lat1, lng1, lat2, lng2) {\n' +
      '    var PI = Math.PI, dLng = (lng2 - lng1) * PI / 180;\n' +
      '    var y = Math.sin(dLng) * Math.cos(lat2 * PI / 180);\n' +
      '    var x = Math.cos(lat1 * PI / 180) * Math.sin(lat2 * PI / 180) - Math.sin(lat1 * PI / 180) * Math.cos(lat2 * PI / 180) * Math.cos(dLng);\n' +
      '    return (Math.atan2(y, x) * 180 / PI + 360) % 360;\n' +
      '  }\n' +
      '\n' +
      '  function addArrows(ll) {\n' +
      '    if (!ll || ll.length < 2) return;\n' +
      '    var total = 0;\n' +
      '    for (var i = 1; i < ll.length; i++) {\n' +
      '      total += calcDist(ll[i-1][0], ll[i-1][1], ll[i][0], ll[i][1]);\n' +
      '    }\n' +
      '    if (total < 0.15) return;\n' +
      '    var numArrows = Math.min(20, Math.max(3, Math.ceil(total / 1.2)));\n' +
      '    var step = total / numArrows;\n' +
      '    var segs = [], acc = 0;\n' +
      '    for (var i = 1; i < ll.length; i++) {\n' +
      '      var dl = calcDist(ll[i-1][0], ll[i-1][1], ll[i][0], ll[i][1]);\n' +
      '      segs.push({f: ll[i-1], t: ll[i], len: dl, acc: acc});\n' +
      '      acc += dl;\n' +
      '    }\n' +
      '    for (var n = 0; n < numArrows; n++) {\n' +
      '      var dist = step * (n + 0.5);\n' +
      '      for (var s = 0; s < segs.length; s++) {\n' +
      '        var seg = segs[s];\n' +
      '        if (dist >= seg.acc && dist < seg.acc + seg.len) {\n' +
      '          var f = (dist - seg.acc) / seg.len;\n' +
      '          var lat = seg.f[0] + (seg.t[0] - seg.f[0]) * f;\n' +
      '          var lng = seg.f[1] + (seg.t[1] - seg.f[1]) * f;\n' +
      '          var rot = calcBrg(seg.f[0], seg.f[1], seg.t[0], seg.t[1]) - 90;\n' +
      '          L.marker([lat, lng], {icon: L.divIcon({\n' +
      '            html: \'<div style="transform:rotate(\' + rot + \'deg);font-size:18px;color:#fff;line-height:1;text-shadow:0 1px 4px rgba(37,99,235,.95)">\u27A4</div>\',\n' +
      '            className: "", iconSize: [18, 18], iconAnchor: [9, 9]\n' +
      '          }), interactive: false, keyboard: false}).addTo(map);\n' +
      '          break;\n' +
      '        }\n' +
      '      }\n' +
      '    }\n' +
      '  }\n' +
      '\n' +
      '  function calcDist(lat1, lng1, lat2, lng2) {\n' +
      '    var R = 6371, PI = Math.PI;\n' +
      '    var dLat = (lat2 - lat1) * PI / 180, dLng = (lng2 - lng1) * PI / 180;\n' +
      '    var h = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*PI/180) * Math.cos(lat2*PI/180) * Math.sin(dLng/2) * Math.sin(dLng/2);\n' +
      '    return 2 * R * Math.asin(Math.sqrt(h));\n' +
      '  }\n' +
      '\n' +
      '  // MapTiler слой с русским\n' +
      '  fetch("https://api.maptiler.com/maps/streets-v2/style.json?key=" + KEY)\n' +
      '    .then(function(r) { return r.json(); })\n' +
      '    .then(function(style) {\n' +
      '      var ru = ["coalesce", ["get", "name:ru"], ["get", "name"]];\n' +
      '      (style.layers || []).forEach(function(l) {\n' +
      '        if (l.layout && l.layout["text-field"]) {\n' +
      '          var j = JSON.stringify(l.layout["text-field"]);\n' +
      '          if (j.indexOf("name") !== -1) l.layout["text-field"] = ru;\n' +
      '        }\n' +
      '      });\n' +
      '      L.maptilerLayer({apiKey: KEY, style: style, tileSize: 512, zoomOffset: -1, crossOrigin: true}).addTo(map);\n' +
      '      drawAll();\n' +
      '    })\n' +
      '    .catch(function() {\n' +
      '      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19}).addTo(map);\n' +
      '      drawAll();\n' +
      '    });\n' +
      '}\n' +
      'start();\n' +
      '</scr' + 'ipt>\n</body>\n</html>';

    var blob = new Blob([html], {type: 'text/html'});
    var url = URL.createObjectURL(blob);
    var w = window.open(url, '_blank');
    if (!w) { toast('err', 'Разрешите всплывающие окна'); return; }
    // Освобождаем URL через минуту
    setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
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

  // === GraphHopper Routing API ===
  // Нужен бесплатный ключ: зарегистрируйтесь на https://graphhopper.com (Dashboard → API Keys)
  // Вставьте ключ в config.js: graphhopperApiKey: 'ВАШ_КЛЮЧ'
  function applyGraphHopperRouteStats(orderedTasks, base, callback) {
    if (!orderedTasks || !orderedTasks.length) { if (callback) callback(false, 0); return; }
    var ghKey = (window.SP_CONFIG && SP_CONFIG.graphhopperApiKey) || '';
    if (!ghKey) { console.warn('GraphHopper: нет API-ключа'); if (callback) callback(false, 0); return; }

    // GraphHopper принимает координаты как "lat,lng"
    var points = [base.lat + ',' + base.lng];
    orderedTasks.forEach(function(p) { if (p.lat != null && p.lng != null) points.push(p.lat + ',' + p.lng); });
    points.push(base.lat + ',' + base.lng);

    var url = 'https://graphhopper.com/api/1/route?' +
      points.map(function(p) { return 'point=' + encodeURIComponent(p); }).join('&') +
      '&profile=car&locale=ru&points_encoded=false&key=' + ghKey;

    fetch(url).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.paths && res.paths[0]) {
        var path = res.paths[0];
        var totalKm = (path.distance || 0) / 1000;
        var totalMin = Math.max(1, Math.round((path.time || 0) / 60000));

        // Распределяем по отрезкам если есть legs
        if (path.instructions) {
          orderedTasks.forEach(function(p, idx) {
            p.travelKm = totalKm / orderedTasks.length;
            p.travelKmText = p.travelKm.toFixed(1).replace('.', ',') + ' км';
            p.travelMin = Math.round(totalMin / orderedTasks.length);
            p.travelText = fmtDuration(p.travelMin);
            var st = findTask(p.id);
            if (st) { st.travelKm = p.travelKm; st.travelKmText = p.travelKmText; st.travelMin = p.travelMin; st.travelText = p.travelText; if (TASKS_DB) TASKS_DB.updateTask(st.id, st); }
          });
        }
        console.log('📊 GraphHopper:', totalKm.toFixed(2), 'км,', totalMin, 'мин');
        if (callback) callback(true, totalKm);
      } else {
        if (callback) callback(false, 0);
      }
    }).catch(function(e) { console.warn('GraphHopper error:', e.message); if (callback) callback(false, 0); });
  }

  // === OpenRouteService Routing API ===
  // Нужен бесплатный ключ: зарегистрируйтесь на https://openrouteservice.org (Sign Up → Dashboard)
  // Вставьте ключ в config.js: orsApiKey: 'ВАШ_КЛЮЧ'
  function applyORSRouteStats(orderedTasks, base, callback) {
    if (!orderedTasks || !orderedTasks.length) { if (callback) callback(false, 0); return; }
    var orsKey = (window.SP_CONFIG && SP_CONFIG.orsApiKey) || '';
    if (!orsKey) { console.warn('OpenRouteService: нет API-ключа'); if (callback) callback(false, 0); return; }

    // ORS принимает координаты как [lng,lat] массивы
    var coords = [[base.lng, base.lat]];
    orderedTasks.forEach(function(p) { if (p.lng != null && p.lat != null) coords.push([p.lng, p.lat]); });
    coords.push([base.lng, base.lat]);

    var url = 'https://api.openrouteservice.org/v2/directions/driving-car';
    fetch(url, {
      method: 'POST',
      headers: { 'Authorization': orsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: coords })
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.routes && res.routes[0]) {
        var route = res.routes[0];
        var summary = route.summary || {};
        var totalKm = (summary.distance || 0) / 1000;
        var totalMin = Math.max(1, Math.round((summary.duration || 0) / 60));

        // Распределяем по сегментам
        if (route.segments) {
          route.segments.forEach(function(seg, idx) {
            if (idx < orderedTasks.length) {
              var p = orderedTasks[idx];
              var segKm = (seg.distance || 0) / 1000;
              var segMin = Math.max(1, Math.round((seg.duration || 0) / 60));
              p.travelKm = segKm; p.travelKmText = segKm.toFixed(1).replace('.', ',') + ' км';
              p.travelMin = segMin; p.travelText = fmtDuration(segMin);
              var st = findTask(p.id);
              if (st) { st.travelKm = segKm; st.travelKmText = p.travelKmText; st.travelMin = segMin; st.travelText = p.travelText; if (TASKS_DB) TASKS_DB.updateTask(st.id, st); }
            }
          });
        }
        console.log('📊 OpenRouteService:', totalKm.toFixed(2), 'км,', totalMin, 'мин');
        if (callback) callback(true, totalKm);
      } else {
        if (callback) callback(false, 0);
      }
    }).catch(function(e) { console.warn('ORS error:', e.message); if (callback) callback(false, 0); });
  }

  /* =====================================================================
     РЕНДЕР: ИНТЕРАКТИВНАЯ КАРТА СЕТЕЙ
     ===================================================================== */
  function renderGMap() {
    var view = document.getElementById('view');
    var embedUrl = 'https://www.google.com/maps/d/embed?mid=10qbguyGMSQpSVy8laN-837nqb1EUHR0';

    var html = '<div style="height:calc(100vh - 62px);width:100%;position:relative;display:flex;flex-direction:column;background:#e8eef3;">' +
      '<iframe src="' + embedUrl + '" allowfullscreen loading="lazy" title="Интерактивная карта сетей УП МИНГАЗ" style="flex:1;width:100%;height:100%;border:0;display:block;"></iframe>' +
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
      
      // Контейнер сверху справа (поверх iframe)
      '<div class="perms-wrapper" style="position:absolute;top:8px;right:12px;z-index:20;text-align:center;">' +
        
        // Сама кнопка (уменьшенная в 2 раза)
        '<a href="' + permsUrl + '" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;background:#dc2626;color:#fff;border-radius:6px;font-size:9px;font-weight:700;text-decoration:none;box-shadow:0 2px 8px rgba(220,38,38,0.4);cursor:pointer;transition:0.2s;">' +
          '🔧 Исправить ошибку' +
        '</a>' +
        
        // Окно подсказки (скрыто по умолчанию)
        '<div class="perms-tooltip" style="position:absolute;top:100%;right:0;margin-top:8px;padding:14px 18px;background:#1f2937;color:#fff;border-radius:10px;font-size:13px;line-height:1.7;box-shadow:0 10px 30px rgba(0,0,0,0.5);width:340px;max-width:90vw;text-align:left;display:none;">' +
          'Если сайт не открывается:<br>' +
          'Нажмите кнопку <b style="color:#fca5a5;background:rgba(220,38,38,0.3);padding:1px 6px;border-radius:4px;">исправить ошибку</b>,<br>' +
          'при переходе на сайт нажмите кнопку <b style="color:#fde047;background:rgba(250,204,21,0.2);padding:1px 6px;border-radius:4px;">дополнительные настройки</b><br>' +
          'и <b style="color:#86efac;background:rgba(34,197,94,0.2);padding:1px 6px;border-radius:4px;">Перейти на сайт 178.124.167.87</b>' +
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
    var h = '<div class="modal-h"><h3>' + esc(title) + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
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
    if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; }
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
    if (mode === 'edit') { WORK.updateWork(area, wid, data); logAction('Изменение вида работы', data.name);
        toast('ok', 'Работа обновлена'); }
    else { WORK.addWork(area, data); logAction('Добавление вида работы', data.name);
        toast('ok', 'Работа добавлена на участок ' + area); }
    overlay.classList.remove('show'); renderRefs();
  }
  function delWork(wid) {
    if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; }
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
      var html = '<div class="card"><div class="card-h"><h2>Пользователи системы</h2><span class="sub">' + users.length + ' учётных записей</span><div class="spacer"></div><button class="btn sm" data-action="export-db" title="Сохранить базу в Excel">' + IC.download + ' Экспорт в Excel</button>' + (S.role === 'admin' ? '<button class="btn sm" data-action="import-db" title="Загрузить базу из Excel">' + IC.upload + ' Импорт из Excel</button>' : '') + '<input type="file" id="import-file" accept=".xlsx,.xls,.csv" style="display:none">';
      if (S.role === 'admin') {
        html += '<button class="btn primary" data-action="new-user">' + IC.plus + ' Добавить пользователя</button>';
      }
      html += '</div><div class="card-b">';
      if (users.length <= 1) {
        html += '<div style="margin-bottom:14px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid var(--yellow);border-radius:10px;padding:13px 15px;display:flex;gap:12px;align-items:flex-start">' + IC.info + '<div style="flex:1;font-size:12.5px;color:#78350f;line-height:1.6"><b>Новый браузер или компьютер?</b><br>Каждый браузер хранит свою базу пользователей отдельно (в Chrome их не видно из Edge и наоборот). Если пользователи уже заведены в другом браузере — перенесите их файлом:<div style="margin-top:9px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm primary" data-action="import-db">' + IC.upload + ' Импорт из файла</button><a href="#" style="font-size:11px;color:var(--blue);align-self:center" data-action="how-transfer">Как это сделать?</a></div></div></div>';
      }
      html += '<table class="dt"><thead><tr><th>ФИО</th><th>Логин</th><th>Пароль для входа</th><th>Роль</th><th>Участок</th><th>Статус</th><th style="text-align:right">Действия</th></tr></thead><tbody>';
      users.forEach(function (u) {
        if (!u) return;
        var me = (S.user && u.id === S.user.id) ? ' <span style="color:var(--green);font-size:11px">(вы)</span>' : '';
        var delBtn = (u.id === 'u_seogs') ? '' : (u.role === 'admin' && DB.countAdmins() <= 1 ? '' : '<button class="btn sm" data-action="del-user" data-uid="' + u.id + '" style="color:var(--red)">Удалить</button>');
        var displayPass = u.plain_password || 'admin123';
        var passLabel = '<span style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;color:#0f2740;font-weight:700;">' + esc(displayPass) + '</span>';
        var actionsHtml = (S.role === 'admin') ? '<button class="btn sm" data-action="edit-user" data-uid="' + u.id + '">Изменить</button> ' + delBtn : '<span style="color:#94a3b8;font-size:11.5px;">Доступно админу</span>';
        html += '<tr><td><b>' + esc(u.full_name) + '</b>' + me + '</td><td style="font-family:monospace;font-weight:700;color:var(--blue);">' + esc(u.login) + '</td><td>' + passLabel + '</td><td>' + roleChip(u.role) + '</td><td>' + esc(u.area || '—') + '</td><td>' + (u.active ? '<span class="chip" style="background:#dcfce7;color:#15803d">активен</span>' : '<span class="chip" style="background:#fee2e2;color:#b91c1c">отключён</span>') + '</td><td style="white-space:nowrap;text-align:right">' + actionsHtml + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
      var view = document.getElementById('view');
      if (view) view.innerHTML = html;
      var finput = document.getElementById('import-file');
      if (finput) {
        finput.onchange = function (e) {
          var f = e.target.files && e.target.files[0];
          if (!f) return;
          importDbFile(f);
          e.target.value = '';
        };
      }
    } catch (err) {
      console.error('renderUsers error:', err);
      var viewEl = document.getElementById('view');
      if (viewEl) viewEl.innerHTML = '<div class="card"><div class="card-b" style="color:var(--red);padding:20px;font-weight:600;">Ошибка отображения списка пользователей: ' + esc(err.message) + '</div></div>';
    }
  }
  /* =====================================================================
     РЕНДЕР: БАЗА ЗНАНИЙ AI (только администратор, хранится на сервере)
     ===================================================================== */
  function getAIKB() {
    try { var raw = localStorage.getItem('smartplan_ai_kb'); if (raw) return JSON.parse(raw); } catch(e) {}
    return { text: '', updatedAt: 0 };
  }
  function saveAIKBLocal(text, updatedBy) {
    try { localStorage.setItem('smartplan_ai_kb', JSON.stringify({ text: text, updatedAt: Date.now(), updatedBy: updatedBy || '' })); } catch(e) {}
  }
  function loadAIKBFromServer() {
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    if (!API || !DB.isServerOnline()) return Promise.resolve(getAIKB());
    return fetch(API + '/api/aikb').then(function(r) { return r.json(); }).then(function(data) {
      if (data && data.text != null) {
        saveAIKBLocal(data.text, data.updated_by);
        return { text: data.text, updatedAt: data.updated_at, updatedBy: data.updated_by };
      }
      return getAIKB();
    }).catch(function() { return getAIKB(); });
  }
  function saveAIKBToServer(text) {
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    var u = S.user || {};
    if (!API || !DB.isServerOnline()) { saveAIKBLocal(text, u.full_name); return Promise.resolve({ ok: true }); }
    return fetch(API + '/api/aikb', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, updated_by: u.full_name || '' })
    }).then(function(r) { return r.json(); }).then(function() {
      saveAIKBLocal(text, u.full_name);
      return { ok: true };
    });
  }
  function logAction(action, details) {
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    if (!API || !DB.isServerOnline()) return;
    var u = S.user || {};
    fetch(API + '/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: u.id || '', user_name: u.full_name || '', action: action || '', details: details || '' })
    }).catch(function() {});
  }

  function renderAIKB() {
    // Загружаем с сервера асинхронно
    view.innerHTML = '<div class="card"><div class="card-b"><div class="empty">Загрузка базы знаний...</div></div></div>';
    loadAIKBFromServer().then(function(kb) {
      renderAIKBContent(kb);
    });
  }

  function renderAIKBContent(kb) {
    var updatedInfo = parseLogDate(kb.updatedAt);
    var updatedStr = updatedInfo ? updatedInfo.getDate() + ' ' + MON[updatedInfo.getMonth()] + ' ' + updatedInfo.getFullYear() + ' ' + updatedInfo.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}) : '\u2014';
    var updatedBy = kb.updatedBy ? ' \u00b7 ' + esc(kb.updatedBy) : '';

    var html = '<div class="card">';
    html += '<div class="card-h"><h2>\uD83E\uDD16 База знаний AI-ассистента</h2><span class="sub">обновлено: ' + updatedStr + updatedBy + '</span><div class="spacer"></div>';
    html += (S.role === 'admin' ? '<button class="btn sm" id="btn-clear-aikb" style="color:var(--red)">Очистить</button>' : '');
    html += '</div><div class="card-b">';
    html += '<div class="calc" style="margin-bottom:14px">' + IC.info + ' База знаний хранится на сервере и одинакова для всех. Текст добавляется к системному промпту AI при каждом запросе.</div>';
    html += '<div class="fld"><label>Текст базы знаний (правила, инструкции, нормативы)</label>';
    html += '<textarea id="aikb-text" style="width:100%;min-height:400px;padding:12px;border:1px solid var(--line);border-radius:9px;font-size:13px;font-family:inherit;color:var(--ink);background:#fff;line-height:1.6;resize:vertical;" placeholder="1. Рабочий день 8 часов.\n2. Все работы на участке УБиРОГС.\n3. Снегоуборка в течение 48 часов после снегопада."' + (S.role === 'viewer' ? ' readonly' : '') + '>' + esc(kb.text || '') + '</textarea>';
    html += '</div>';
    html += (S.role === 'admin'
      ? '<div style="display:flex;gap:10px;align-items:center;margin-top:4px"><button class="btn primary" id="btn-save-aikb">' + IC.check + ' Сохранить</button><span id="aikb-status" style="font-size:12px;color:var(--muted)"></span></div>'
      : '<div style="margin-top:6px;font-size:12px;color:var(--muted)">👁 Режим просмотра — редактирование базы знаний доступно только администратору</div>');
    html += '</div></div>';
    view.innerHTML = html;

    var saveBtn = document.getElementById('btn-save-aikb');
    if (saveBtn) saveBtn.addEventListener('click', function() {
      var ta = document.getElementById('aikb-text');
      var text = ta ? ta.value : '';
      var st = document.getElementById('aikb-status');
      if (st) { st.textContent = '\u23F3 Сохранение...'; st.style.color = 'var(--blue)'; }
      saveAIKBToServer(text).then(function() {
        if (st) { st.textContent = '\u2713 Сохранено на сервере'; st.style.color = 'var(--green)'; setTimeout(function() { if (st) st.textContent = ''; }, 3000); }
        toast('ok', '\u2713 База знаний AI сохранена на сервере');
        logAction('Сохранение базы знаний AI', '');
      }).catch(function() {
        if (st) { st.textContent = '\u26A0 Ошибка'; st.style.color = 'var(--red)'; }
        toast('err', 'Ошибка сохранения');
      });
    });
    var clearBtn = document.getElementById('btn-clear-aikb');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      if (!window.confirm('Очистить базу знаний AI?')) return;
      saveAIKBToServer('').then(function() {
        var ta = document.getElementById('aikb-text');
        if (ta) ta.value = '';
        toast('ok', 'База знаний очищена');
        renderAIKB();
      });
    });
  }

  /* =====================================================================
     РЕНДЕР: ЖУРНАЛ ДЕЙСТВИЙ (только администратор)
     ===================================================================== */
  function renderLogs() {
    view.innerHTML = '<div class="card"><div class="card-b"><div class="empty">Загрузка журнала...</div></div></div>';
    var API = (window.SP_CONFIG && SP_CONFIG.serverUrl) || '';
    if (!API || !DB.isServerOnline()) {
      view.innerHTML = '<div class="card"><div class="card-b"><div class="empty">⚠ Сервер недоступен. Журнал действий работает только при подключении к серверу.<br><br><span style="font-size:12px">Статус сервера: ' + (API ? 'офлайн' : 'не настроен') + '</span></div></div></div>';
      return;
    }
    fetch(API + '/api/logs?limit=500').then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(data) {
      if (data && data.error) throw new Error(data.error);
      renderLogsContent((data && data.logs) || []);
    }).catch(function(err) {
      view.innerHTML = '<div class="card"><div class="card-b"><div style="padding:20px;color:var(--red);font-size:13px">' +
        '<b>⚠ Ошибка загрузки журнала</b><br><br>' +
        'Причина: ' + esc(err.message || 'неизвестна') + '<br><br>' +
        '<span style="color:var(--muted);font-size:12px">Возможно, сервер нужно обновить (redeploy) или таблица action_logs ещё не создана в базе данных.</span>' +
        '</div></div></div>';
    });
  }

  // Надёжный разбор даты журнала: created_at из PostgreSQL BIGINT приходит СТРОКОЙ
  function parseLogDate(v) {
    if (v == null) return null;
    if (typeof v === 'number') { var dn = new Date(v); return isNaN(dn.getTime()) ? null : dn; }
    var str = String(v);
    if (/^\d+$/.test(str)) { var dn2 = new Date(parseInt(str, 10)); return isNaN(dn2.getTime()) ? null : dn2; }
    var d = new Date(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') : str);
    return isNaN(d.getTime()) ? null : d;
  }

  function renderLogsContent(logs) {
    var users = {}, actions = {};
    logs.forEach(function(l) {
      if (l.user_name) users[l.user_name] = 1;
      if (l.action) actions[l.action] = 1;
    });
    var userList = Object.keys(users).sort();
    var actionList = Object.keys(actions).sort();

    var html = '<div class="card"><div class="card-h"><h2>\uD83D\uDCCB Журнал действий</h2><span class="sub">' + logs.length + ' записей</span><div class="spacer"></div>' + (S.role === 'admin' ? '<button class="btn sm" id="btn-clear-logs" style="color:var(--red)">Очистить журнал</button>' : '') + '</div>';
    html += '<div class="card-b">';
    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
    html += '<select id="log-filter-user" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff"><option value="">Все пользователи</option>';
    userList.forEach(function(u) { html += '<option value="' + esc(u) + '">' + esc(u) + '</option>'; });
    html += '</select>';
    html += '<select id="log-filter-action" style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff"><option value="">Все действия</option>';
    actionList.forEach(function(a) { html += '<option value="' + esc(a) + '">' + esc(a) + '</option>'; });
    html += '</select>';
    html += '<input type="text" id="log-search" placeholder="Поиск..." style="padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;flex:1;min-width:150px">';
    html += '</div>';
    html += '<table class="dt"><thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Детали</th></tr></thead><tbody>';
    logs.forEach(function(l) {
      var d = parseLogDate(l.created_at);
      var dStr = d ? d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ' ' + d.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}) : '\u2014';
      html += '<tr class="log-row" data-user="' + esc(l.user_name || '') + '" data-action="' + esc(l.action || '') + '" data-details="' + esc(l.details || '') + '">';
      html += '<td style="white-space:nowrap;font-size:12px;color:var(--muted)">' + dStr + '</td>';
      html += '<td style="font-weight:600">' + esc(l.user_name || '\u2014') + '</td>';
      html += '<td>' + esc(l.action || '\u2014') + '</td>';
      html += '<td style="font-size:12px;color:var(--muted)">' + esc(l.details || '') + '</td>';
      html += '</tr>';
    });
    if (!logs.length) html += '<tr><td colspan="4" class="empty">Записей нет</td></tr>';
    html += '</tbody></table>';
    html += '</div></div>';
    view.innerHTML = html;

    var fu = document.getElementById('log-filter-user');
    var fa = document.getElementById('log-filter-action');
    var fs = document.getElementById('log-search');
    function applyFilter() {
      var uv = fu ? fu.value.toLowerCase() : '';
      var av = fa ? fa.value.toLowerCase() : '';
      var sv = fs ? fs.value.toLowerCase() : '';
      document.querySelectorAll('.log-row').forEach(function(row) {
        var match = (!uv || (row.dataset.user || '').toLowerCase().indexOf(uv) !== -1) &&
                    (!av || (row.dataset.action || '').toLowerCase().indexOf(av) !== -1) &&
                    (!sv || (row.dataset.user + ' ' + row.dataset.action + ' ' + row.dataset.details).toLowerCase().indexOf(sv) !== -1);
        row.style.display = match ? '' : 'none';
      });
    }
    if (fu) fu.addEventListener('change', applyFilter);
    if (fa) fa.addEventListener('change', applyFilter);
    if (fs) fs.addEventListener('input', applyFilter);
    var clearBtn = document.getElementById('btn-clear-logs');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      if (!window.confirm('Очистить весь журнал действий?')) return;
      fetch(API + '/api/logs', { method: 'DELETE' }).then(function() { toast('ok', 'Журнал очищен'); renderLogs(); });
    });
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
      logAction(mode === 'new' ? 'Добавление пользователя' : 'Изменение пользователя', full_name);
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

  /* ---------- ЭКСПОРТ / ИМПОРТ БАЗЫ УЧЁТОК (Excel) ---------- */
  function exportDb() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var users = DB.getUsers() || [];
    var data = [];
    data.push(['ФИО', 'Логин', 'Пароль для входа', 'Роль', 'Участок', 'Статус', 'Действия']);
    users.forEach(function (u) {
      if (!u) return;
      var roleName = (ROLE_INFO[u.role] || { label: u.role }).label;
      var status = u.active ? 'активен' : 'отключён';
      data.push([u.full_name || '', u.login || '', u.plain_password || 'admin123', roleName, u.area || '—', status, '']);
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Пользователи');
    var fileName = 'База_пользователей_' + key(TODAY) + '.xlsx';
    try {
      XLSX.writeFile(wb, fileName);
      toast('ok', '📥 Скачан файл: ' + fileName + ' (' + users.length + ' записей)');
    } catch (err) {
      console.error('Ошибка Excel:', err);
      toast('err', 'Ошибка: ' + err.message);
    }
  }

  function importDbFile(file) {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        if (!rows || rows.length < 2) { toast('warn', 'Файл пуст'); return; }

        // Поиск столбцов по заголовкам
        var headers = rows[0].map(function (h) { return String(h || '').toLowerCase().trim(); });
        var idxName = -1, idxLogin = -1, idxPass = -1, idxRole = -1, idxArea = -1, idxStatus = -1;
        headers.forEach(function (h, i) {
          if (h.indexOf('фио') !== -1 || h.indexOf('имя') !== -1) idxName = i;
          else if (h.indexOf('логин') !== -1) idxLogin = i;
          else if (h.indexOf('пароль') !== -1) idxPass = i;
          else if (h.indexOf('роль') !== -1) idxRole = i;
          else if (h.indexOf('участ') !== -1) idxArea = i;
          else if (h.indexOf('статус') !== -1) idxStatus = i;
        });
        if (idxLogin === -1) { toast('err', 'Не найден столбец «Логин»'); return; }
        if (idxName === -1) idxName = 0;
        if (idxPass === -1) idxPass = 2;
        if (idxRole === -1) idxRole = 3;
        if (idxArea === -1) idxArea = 4;
        if (idxStatus === -1) idxStatus = 5;

        // Обратный словарь ролей
        var roleMap = {};
        Object.keys(ROLE_INFO).forEach(function (r) { roleMap[ROLE_INFO[r].label.toLowerCase()] = r; });

        var replace = window.confirm(
          'Импорт пользователей из Excel?\n\n' +
          '• ОК — ОБНОВИТЬ существующих и ДОБАВИТЬ новых\n' +
          '• Отмена — только ДОБАВИТЬ новых (существующих не трогать)'
        );

        var existingUsers = DB.getUsers();
        var added = 0, updated = 0;
        var pending = 0;

        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          if (!row || !row.length) continue;
          var fullName = String(row[idxName] != null ? row[idxName] : '').trim();
          var login = String(row[idxLogin] != null ? row[idxLogin] : '').trim();
          if (!login) continue;

          var password = String(row[idxPass] != null ? row[idxPass] : 'admin123').trim() || 'admin123';
          var roleName = String(row[idxRole] != null ? row[idxRole] : '').trim().toLowerCase();
          var role = roleMap[roleName] || 'master';
          var area = String(row[idxArea] != null ? row[idxArea] : '').trim();
          if (area === '—' || area === '') area = '';
          var statusStr = String(row[idxStatus] != null ? row[idxStatus] : '').trim().toLowerCase();
          var active = statusStr.indexOf('актив') !== -1 || statusStr === '';

          // Поиск существующего
          var existing = null;
          for (var j = 0; j < existingUsers.length; j++) {
            if (existingUsers[j].login.toLowerCase() === login.toLowerCase()) { existing = existingUsers[j]; break; }
          }

          if (existing && replace) {
            pending++;
            DB.updateUser(existing.id, {
              full_name: fullName || existing.full_name, login: login, password: password,
              role: role, area: area, active: active
            }).then(function () { updated++; }).catch(function () {});
          } else if (!existing) {
            pending++;
            DB.addUser({
              full_name: fullName || login, login: login, password: password,
              role: role, area: area, active: active
            }).then(function () { added++; }).catch(function () {});
          }
        }

        toast('ok', '✓ Импорт запущен: добавляется ' + (pending) + ' записей');
        setTimeout(function() { toast('ok', 'Готово: добавлено ' + added + ', обновлено ' + updated); refresh(); }, 1500);
      } catch (err) {
        console.error('Ошибка импорта Excel:', err);
        toast('err', 'Ошибка чтения Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
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
  /* =====================================================================
     ОТЧЁТЫ: помощники для выбранного отчётного месяца
     ===================================================================== */
  // Возвращает {y, m} выбранного отчётного месяца (по умолчанию — текущий)
  function getReportMY() {
    if (S.reportMonth) return { y: S.reportMonth.year, m: S.reportMonth.month };
    return { y: TODAY.getFullYear(), m: TODAY.getMonth() };
  }
  // Строка периода отчёта: «июля 2026»
  function reportPeriodStr() { var p = getReportMY(); return MON_NOM[p.m] + ' ' + p.y; }
  // Фильтр задач по выбранному отчётному месяцу (по плановой дате)
  function filterReportMonth(tasks) {
    var p = getReportMY();
    return tasks.filter(function (t) { var d = offToDate(t.d); return d.getMonth() === p.m && d.getFullYear() === p.y; });
  }
  // Сокращённый YYYY-MM для имени файла (отчётный месяц)
  function reportMonthKey() { var p = getReportMY(); return p.y + '-' + String(p.m + 1).padStart(2, '0'); }

  // === Состояние календаря выбора месяца в отчётах ===
  var rmState = { viewYear: TODAY.getFullYear() };

  function toggleReportMonthPicker() {
    var dd = document.getElementById('report-month-dropdown');
    if (!dd) return;
    if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
    var p = getReportMY();
    rmState.viewYear = p.y;
    renderReportMonthPicker();
    // Позиционируем по кнопке
    var btn = document.querySelector('[data-action="report-month-toggle"]');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      dd.style.top = (rect.bottom + 6) + 'px';
      dd.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 316)) + 'px';
    }
    dd.classList.add('open');
  }

  function renderReportMonthPicker() {
    var dd = document.getElementById('report-month-dropdown');
    if (!dd) return;
    var p = getReportMY();
    var html = '';
    html += '<div class="rm-head">';
    html += '<button type="button" data-action="rm-prev-year">‹</button>';
    html += '<span class="rm-year">' + rmState.viewYear + '</span>';
    html += '<button type="button" data-action="rm-next-year">›</button>';
    html += '<button type="button" class="rm-close" data-action="rm-close">×</button>';
    html += '</div>';
    html += '<div class="rm-grid">';
    for (var mo = 0; mo < 12; mo++) {
      var isSel = (rmState.viewYear === p.y && mo === p.m);
      var isCur = (rmState.viewYear === TODAY.getFullYear() && mo === TODAY.getMonth());
      html += '<button type="button" class="rm-month' + (isSel ? ' selected' : '') + (isCur ? ' current' : '') + '" data-action="rm-pick" data-year="' + rmState.viewYear + '" data-month="' + mo + '">' + MON_NOM[mo] + '</button>';
    }
    html += '</div>';
    dd.innerHTML = html;
  }

  function pickReportMonth(year, month) {
    S.reportMonth = { year: year, month: month };
    var dd = document.getElementById('report-month-dropdown');
    if (dd) dd.classList.remove('open');
    renderReports();
  }

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
      '<div class="hdr"><div class="org">УП «МИНГАЗ» · УБиРОГС</div><h1>' + title + '</h1><div class="date">Период: ' + reportPeriodStr() + ' · Сформирован: ' + fmt(TODAY) + '</div></div>' +
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
    var rows = filterReportMonth(visibleTasks());
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
    filterReportMonth(visibleTasks()).forEach(function (t) { byMaster[t.m] = byMaster[t.m] || { p: 0, f: 0 }; byMaster[t.m].p++; if (isDone(t)) byMaster[t.m].f++; });
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
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { return t.needs_permit; });
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
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { return t.depends_on_snow; });
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
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; });
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

  // === ЭКСПОРТ ОТЧЁТОВ В EXCEL ===
  function exportReport1Excel() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var data = [];
    data.push(['План-график работ — ' + reportPeriodStr()]);
    data.push(['Сформирован: ' + fmt(TODAY)]);
    data.push([]);
    data.push(['Дата', 'Мастер', 'Объект', 'Вид работы', 'Объём', 'Трудозатраты, ч']);

    var rows = filterReportMonth(visibleTasks());
    rows.sort(function (a, b) { if (a.d !== b.d) return a.d - b.d; return addrOf(a).localeCompare(addrOf(b)); });

    rows.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m), d = offToDate(t.d);
      data.push([
        d.getDate() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear(),
        m ? m.name : '—', addrOf(t), w ? w.name : '—',
        (t.volume || 1) + ' ' + (w ? w.unit : ''),
        parseFloat(fmtH(taskHours(t)).replace(',', '.'))
      ]);
    });
    var total = rows.reduce(function (s, t) { return s + taskHours(t); }, 0);
    data.push([]);
    data.push(['', '', '', 'Итого трудозатрат, ч:', parseFloat(fmtH(total).replace(',', '.'))]);

    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 32 }, { wch: 32 }, { wch: 12 }, { wch: 14 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
    XLSX.utils.book_append_sheet(wb, ws, 'План-график');
    var fileName = 'Отчёт_1_План-график_' + reportMonthKey() + '.xlsx';
    try { XLSX.writeFile(wb, fileName); toast('ok', '📥 Сформирован файл: ' + fileName + ' (' + rows.length + ' записей)'); } catch (err) { toast('err', 'Ошибка формирования Excel'); }
  }

  function exportReport2Excel() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var byMaster = {};
    filterReportMonth(visibleTasks()).forEach(function (t) { byMaster[t.m] = byMaster[t.m] || { p: 0, f: 0 }; byMaster[t.m].p++; if (isDone(t)) byMaster[t.m].f++; });
    var totP = 0, totF = 0;
    var data = [];
    data.push(['Анализ выполнения (план/факт) — ' + reportPeriodStr()]);
    data.push(['Сформирован: ' + fmt(TODAY)]);
    data.push([]);
    data.push(['Мастер', 'Участок', 'План', 'Факт', 'Выполнено, %']);
    Object.keys(byMaster).forEach(function (mid) {
      var x = byMaster[mid]; totP += x.p; totF += x.f;
      var m = masterById(mid); var pct = x.p ? Math.round(x.f / x.p * 100) : 0;
      data.push([m ? m.name : '—', m ? m.area : '—', x.p, x.f, pct + '%']);
    });
    var totPct = totP ? Math.round(totF / totP * 100) : 0;
    data.push([]);
    data.push(['Итого:', '', totP, totF, totPct + '%']);
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
    XLSX.utils.book_append_sheet(wb, ws, 'План-факт');
    var fileName = 'Отчёт_2_План_факт_' + reportMonthKey() + '.xlsx';
    try { XLSX.writeFile(wb, fileName); toast('ok', '📥 Сформирован файл: ' + fileName); } catch (err) { toast('err', 'Ошибка формирования Excel'); }
  }

  function exportPermitExcel() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { return t.needs_permit; });
    tasks.sort(function (a, b) { return a.dl - b.dl; });
    var data = [];
    data.push(['Контроль ордеров (разрешений) — ' + reportPeriodStr()]);
    data.push(['Сформирован: ' + fmt(TODAY)]);
    data.push([]);
    data.push(['Вид работы', 'Объект', 'Мастер', 'Ордер до', 'Осталось']);
    tasks.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      var dlDate = t.dl_date || (t.dl != null ? key(offToDate(t.dl)) : '—');
      var daysLeft = t.dl != null ? t.dl : 0;
      var dlText = daysLeft < 0 ? 'просрочка ' + (-daysLeft) + ' дн' : daysLeft === 0 ? 'сегодня!' : daysLeft + ' дн';
      data.push([w ? w.name : '?', addrOf(t), m ? m.name : '—', dlDate, dlText]);
    });
    if (!tasks.length) data.push(['Нет работ с ордерами']);
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 32 }, { wch: 32 }, { wch: 20 }, { wch: 14 }, { wch: 16 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
    XLSX.utils.book_append_sheet(wb, ws, 'Ордера');
    var fileName = 'Контроль_ордеров_' + reportMonthKey() + '.xlsx';
    try { XLSX.writeFile(wb, fileName); toast('ok', '📥 Сформирован файл: ' + fileName); } catch (err) { toast('err', 'Ошибка формирования Excel'); }
  }

  function exportSnowExcel() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { return t.depends_on_snow; });
    var data = [];
    data.push(['Контроль снегоуборки — ' + reportPeriodStr()]);
    data.push(['Сформирован: ' + fmt(TODAY)]);
    data.push([]);
    data.push(['Вид работы', 'Объект', 'Мастер', 'Объём', 'Трудозатраты, ч']);
    tasks.forEach(function (t) {
      var w = workOf(t), m = masterById(t.m);
      data.push([w ? w.name : '?', addrOf(t), m ? m.name : '—', (t.volume || 1) + ' ' + (w ? w.unit : ''), parseFloat(fmtH(taskHours(t)).replace(',', '.'))]);
    });
    if (!tasks.length) data.push(['Нет снегоуборочных работ']);
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 32 }, { wch: 32 }, { wch: 20 }, { wch: 14 }, { wch: 16 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
    XLSX.utils.book_append_sheet(wb, ws, 'Снег');
    var fileName = 'Контроль_снега_' + reportMonthKey() + '.xlsx';
    try { XLSX.writeFile(wb, fileName); toast('ok', '📥 Сформирован файл: ' + fileName); } catch (err) { toast('err', 'Ошибка формирования Excel'); }
  }

  function exportWeatherExcel() {
    if (!window.XLSX) { toast('err', 'Библиотека SheetJS (XLSX) не загружена'); return; }
    var tasks = filterReportMonth(visibleTasks()).filter(function (t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; });
    var data = [];
    data.push(['Ожидание погоды — ' + reportPeriodStr()]);
    data.push(['Сформирован: ' + fmt(TODAY)]);
    data.push([]);
    data.push(['Вид работы', 'Объект', 'Мин. t°C', 'Прогноз t°C', 'Погода', 'План']);
    tasks.forEach(function (t) {
      var w = workOf(t); var wf = getWeatherForecast(t.d);
      data.push([w ? w.name : '?', addrOf(t), w ? w.min_temp : -50, wf ? wf.temp : '?', wf ? wf.desc : '—', fmtShort(t.d)]);
    });
    if (!tasks.length) data.push(['Нет задач в ожидании погоды']);
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 32 }, { wch: 32 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];
    XLSX.utils.book_append_sheet(wb, ws, 'Погода');
    var fileName = 'Ожидание_погоды_' + reportMonthKey() + '.xlsx';
    try { XLSX.writeFile(wb, fileName); toast('ok', '📥 Сформирован файл: ' + fileName); } catch (err) { toast('err', 'Ошибка формирования Excel'); }
  }

  /* ---------- ПОПАП ПОГОДЫ (выпадающий список) ---------- */
  function getWeatherIcon(desc, snowfall, temp) {
    if (desc.indexOf('Снег') !== -1 || (snowfall && snowfall > 0)) return '❄️';
    if (desc.indexOf('Дождь') !== -1 || desc.indexOf('Морось') !== -1 || desc.indexOf('Ливень') !== -1) return '🌧️';
    if (desc.indexOf('Гроза') !== -1) return '⛈️';
    if (desc.indexOf('Облачно') !== -1) return '☁️';
    if (temp != null && temp <= 0) return '🥶';
    return '☀️';
  }

  function toggleWeatherDropdown() {
    var dd = document.getElementById('weather-dropdown');
    if (!dd) return;
    if (dd.classList.contains('open')) {
      dd.classList.remove('open');
      return;
    }
    var html = '';
    // Количество дней прогноза — без ограничения (максимум 15 дней от API)
    var daysCount = 15;

    html += '<div class="wd-head"><div><div class="wd-title">Прогноз погоды</div><div class="wd-sub">Минск · ' + daysCount + ' дн. (нажмите для деталей)</div></div><button class="wd-close" onclick="document.getElementById(\'weather-dropdown\').classList.remove(\'open\')">×</button></div>';
    html += '<div class="wd-grid">';
    for (var off = 0; off < daysCount; off++) {
      var d = offToDate(off);
      var wf = getWeatherForecast(off); // Теперь никогда не возвращает null
      var shortDow = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getDay()];
      var isToday = (off === 0);
      
      var icon = getWeatherIcon(wf.desc, wf.snowfall, wf.temp);
      var delay = off * 0.06;
      html += '<div class="wd-day' + (isToday ? ' today' : '') + '" style="animation-delay:' + delay + 's" data-action="open-hourly" data-off="' + off + '">';
      html += '<div class="wd-dow">' + (isToday ? 'Сегодня' : shortDow) + '</div>';
      html += '<div class="wd-date">' + d.getDate() + ' ' + MON[d.getMonth()].slice(0,3) + '</div>';
      html += '<div class="wd-icon">' + icon + '</div>';
      html += '<div class="wd-temp">' + wf.temp + '°C</div>';
      html += '<div class="wd-desc">' + esc(wf.desc) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    dd.innerHTML = html;
    dd.classList.add('open');
    var _tw = getWeatherForecast(0);
    var _windy = _tw && (_tw.wind || 0) >= 5; // ветер → снос снежинок вправо (амплитуда вправо ×2)
    var _ddRain = _tw && ((_tw.code >= 51 && _tw.code <= 67) || (_tw.code >= 80 && _tw.code <= 82) || _tw.code >= 95 || (_tw.rain && _tw.rain > 0));
    if (_ddRain) {
      var _gl = document.createElement('div');
      _gl.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:14px;pointer-events:none;z-index:0';
      dd.insertBefore(_gl, dd.firstChild);
      var _gdrops = [];
      function _spawnG() {
        var d = { x: Math.random() * 100, y: Math.random() * 15, sp: 0.2 + Math.random() * 1, life: 0, max: 50 + Math.random() * 140, el: document.createElement('div') };
        d.el.className = 'glass-head'; d.el.style.cssText = 'left:' + d.x.toFixed(1) + '%;top:' + d.y.toFixed(0) + 'px;opacity:0';
        _gl.appendChild(d.el);
        setTimeout(function () { d.el.style.opacity = '.5'; }, 50);
        _gdrops.push(d);
      }
      function _tickG() {
        if (!document.getElementById('weather-dropdown').classList.contains('open')) { _gdrops = []; _gl.remove(); return; }
        if (Math.random() < 0.3 && _gdrops.length < 22) _spawnG();
        var _H = _gl.offsetHeight || 300;
        for (var i = _gdrops.length - 1; i >= 0; i--) {
          var d = _gdrops[i]; d.life++;
          var _sp = d.sp * (0.7 + Math.random() * 0.6) * (d.zig ? 0.5 : 1);
          d.y += _sp;
          if (d.zig === undefined) d.zig = Math.random() < 0.4;
          if (d.zig) { d.zc = (d.zc || 0) + 1; var amp = d.zamp || (d.zamp = 0.03 + Math.random() * 0.22); d.x += Math.sin(d.zc * 0.15) * amp; d.el.style.left = d.x.toFixed(1) + '%'; }
          if (d.life % 6 === 0) { var t = document.createElement('div'); t.className = 'glass-trail'; t.style.cssText = 'left:' + d.x.toFixed(1) + '%;top:' + d.y.toFixed(0) + 'px'; _gl.appendChild(t); (function (e) { setTimeout(function () { e.style.opacity = '0'; setTimeout(function () { e.remove(); }, 2500); }, 800); })(t); }
          d.el.style.top = d.y.toFixed(0) + 'px';
          if (d.life > d.max * 0.7 && d.max > 0) { var _p = (d.life - d.max * 0.7) / (d.max * 0.3); var _sc = 1 - _p * 0.85; var _op = 0.5 * (1 - _p); d.el.style.transform = 'scale(' + _sc.toFixed(2) + ')'; d.el.style.opacity = _op.toFixed(2); }
          if (d.life > d.max || d.y > _H) { (function (e) { setTimeout(function () { e.remove(); }, 200); })(d.el); _gdrops.splice(i, 1); }
        }
        requestAnimationFrame(_tickG);
      }
      for (var gi = 0; gi < 10; gi++) _spawnG();
      _tickG();
    }
    // Снежинки на фоне прогноза (если снег): падают как в погоде → уменьшаются до точки → точка исчезает.
    // Комков снега внизу НЕТ.
    var _ddSnow = _tw && ((_tw.code >= 71 && _tw.code <= 77) || _tw.code === 85 || _tw.code === 86 || (_tw.snowfall && _tw.snowfall > 0.1));
    if (_ddSnow) {
      var _sl = document.createElement('div');
      _sl.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:14px;pointer-events:none;z-index:0';
      dd.insertBefore(_sl, dd.firstChild);
      var _snow = [];
      function _spawnS() {
        var d = { x: Math.random() * 100, y: -5, sp: 0.15 + Math.random() * 0.5, sw: 0.1 + Math.random() * 0.3, ph: Math.random() * 6.28, state: 'fall', life: 0, maxFall: 100 + Math.random() * 140, op: 0.5 + Math.random() * 0.35, el: document.createElement('div') };
        d.el.className = 'glass-flake'; d.el.style.cssText = 'left:' + d.x.toFixed(1) + '%;top:' + d.y.toFixed(0) + 'px;opacity:0';
        _sl.appendChild(d.el);
        setTimeout(function () { d.el.style.opacity = d.op.toFixed(2); }, 50);
        _snow.push(d);
      }
      function _tickS() {
        if (!document.getElementById('weather-dropdown').classList.contains('open')) { _snow = []; _sl.remove(); return; }
        if (Math.random() < 0.4 && _snow.length < 30) _spawnS();
        var _H = _sl.offsetHeight || 300;
        for (var i = _snow.length - 1; i >= 0; i--) {
          var d = _snow[i];
          // Движение по траектории (падение + колыхание) — во ВСЕХ фазах,
          // чтобы превратившись в точку, она продолжала лететь, пока не исчезнет.
          // При ветре: траектория-волна сохраняется, но амплитуда вправо ×3 больше влево
          // + постоянный снос вправо → снежинка явно уходит вправо по ветру.
          d.ph += 0.04; d.y += d.sp * (0.8 + Math.random() * 0.4);
          var _sx = Math.sin(d.ph);
          d.x += _sx * (_windy && _sx > 0 ? 3 : 1) * d.sw + (_windy ? 0.08 : 0);
          d.el.style.left = d.x.toFixed(1) + '%'; d.el.style.top = d.y.toFixed(0) + 'px';
          if (d.state === 'fall') {
            // Фаза 1: снежинка падает и колышется, как в погодной сцене
            d.life++;
            // Переход к уменьшению: по времени жизни ИЛИ у нижнего края (без комков!)
            if (d.life > d.maxFall || d.y > _H - 4) { d.state = 'shrink'; d.hl = 0; d.hm = 26 + Math.random() * 34; }
          } else if (d.state === 'shrink') {
            // Фаза 2: снежинка уменьшается и превращается в точку (scale 1.0 → 0.28), продолжая лететь
            d.hl++; var _hp = d.hl / d.hm;
            d.el.style.transform = 'scale(' + (1 - _hp * 0.72).toFixed(3) + ')';
            if (d.hl > d.hm) { d.state = 'fade'; d.fl = 0; d.fm = 22 + Math.random() * 26; }
          } else if (d.state === 'fade') {
            // Фаза 3: точка летит дальше по траектории, уменьшается и пропадает (scale 0.28 → 0, opacity → 0)
            d.fl++; var _fp = d.fl / d.fm;
            d.el.style.transform = 'scale(' + (0.28 * (1 - _fp)).toFixed(3) + ')';
            d.el.style.opacity = (d.op * (1 - _fp)).toFixed(2);
            if (d.fl > d.fm) { d.el.remove(); _snow.splice(i, 1); }
          }
        }
        requestAnimationFrame(_tickS);
      }
      for (var si = 0; si < 12; si++) _spawnS();
      _tickS();
    }
  }

  function initWeatherPopup() {}

  function openHourlyWeather(off) {
    var d = offToDate(off);
    var wf = getWeatherForecast(off);
    if (!wf) {
      toast('warn', 'Нет подробных данных за этот день');
      return;
    }

    // Надёжный разбор времени восхода/заката (устойчив к формату "HH:MM" и ISO)
    function fmtSunTime(val) {
      if (!val) return '—';
      var dt = new Date(val);
      if (!isNaN(dt.getTime())) return dt.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
      var m = String(val).match(/(\d{1,2}:\d{2})/);
      if (m) return m[1];
      return '—';
    }
    var sunrise = fmtSunTime(wf.sunrise);
    var sunset = fmtSunTime(wf.sunset);

    // Наличие осадков: снег или дождь за день
    var precipIcon, precipType, precipAmount;
    if (wf.snowfall && wf.snowfall > 0.1) {
      precipIcon = '❄️'; precipType = 'Снег'; precipAmount = (Math.round(wf.snowfall * 10) / 10) + ' см';
    } else if (wf.rain && wf.rain > 0.1) {
      precipIcon = '🌧️'; precipType = 'Дождь'; precipAmount = (Math.round(wf.rain * 10) / 10) + ' мм';
    } else if (wf.precip && wf.precip > 0.1) {
      precipIcon = '💧'; precipType = 'Осадки'; precipAmount = (Math.round(wf.precip * 10) / 10) + ' мм';
    } else {
      precipIcon = '☀️'; precipType = 'Без осадков'; precipAmount = '0 мм';
    }

    var html = '<div class="modal-h" style="background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;"><h3 style="color:#fff">Погода подробно · ' + d.getDate() + ' ' + MON[d.getMonth()] + '</h3><button class="x" data-action="close-modal" style="color:#fff">×</button></div>';
    html += '<div class="modal-b">';
    
    // Информация о Солнце и Луне
    html += '<div style="display:flex;justify-content:space-around;align-items:center;background:#f8fafc;padding:16px;border-radius:10px;margin-bottom:16px;text-align:center;font-size:12px;color:#334155;gap:10px;">';
    html += '<div>☀️<br><span style="font-size:10px;color:#64748b">Восход</span><br><b>' + sunrise + '</b></div>';
    html += '<div>🌇<br><span style="font-size:10px;color:#64748b">Закат</span><br><b>' + sunset + '</b></div>';
    html += '<div>' + precipIcon + '<br><span style="font-size:10px;color:#64748b">Осадки</span><br><b style="font-size:12px">' + precipType + '</b><br><span style="font-size:10px;color:#64748b">' + precipAmount + '</span></div>';
    html += '</div>';

    // Почасовой прогноз
    if (wf.hourly && wf.hourly.length) {
      html += '<div style="display:flex;flex-direction:column;gap:2px;">';
      wf.hourly.forEach(function(h) {
        var icon = getWeatherIcon(h.desc, h.snowfall, h.temp);
        var isDay = h.hour >= 6 && h.hour <= 22;
        // Колонка осадков: факт (снег/дождь) или вероятность
        var precipStr = '';
        if (h.snowfall && h.snowfall > 0) precipStr = '❄️ ' + (Math.round(h.snowfall * 10) / 10) + 'см';
        else if (h.rain && h.rain > 0) precipStr = '🌧️ ' + (Math.round(h.rain * 10) / 10) + 'мм';
        else if (h.precipProb && h.precipProb > 0) precipStr = '💧 ' + h.precipProb + '%';
        // Цвет температуры
        var tColor = h.temp < 0 ? '#3b82f6' : h.temp > 22 ? '#dc2626' : 'var(--ink)';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--line);font-size:13.5px;' + (isDay ? '' : 'opacity:0.5;') + '">';
        html += '<div style="width:46px;font-weight:700;color:var(--muted)">' + (h.hour < 10 ? '0' + h.hour : h.hour) + ':00</div>';
        html += '<div style="width:28px;text-align:center;font-size:16px;">' + icon + '</div>';
        html += '<div style="flex:1;color:var(--txt)">' + esc(h.desc) + '</div>';
        html += '<div style="font-weight:700;width:54px;text-align:right;color:' + tColor + ';">' + h.temp + '°</div>';
        html += '<div style="width:78px;text-align:right;font-size:12px;color:#0ea5e9;font-weight:600;">' + precipStr + '</div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="empty">Почасовой прогноз недоступен</div>';
    }

    html += '</div>';
    html += '<div class="modal-f"><button class="btn" data-action="close-modal">Закрыть</button></div>';
    
    modal.innerHTML = html;
    overlay.classList.add('show');
  }

  function renderReports() {
    var vt = visibleTasks();
    var monthTasks = filterReportMonth(vt);
    var permitTasks = filterReportMonth(vt).filter(function (t) { return t.needs_permit; });
    var snowTasks = filterReportMonth(vt).filter(function (t) { return t.depends_on_snow; });
    var weatherBlocked = filterReportMonth(vt).filter(function (t) { var w = workOf(t); var wf = getWeatherForecast(t.d); return w && w.min_temp > -50 && wf && wf.temp != null && wf.temp < w.min_temp; });

    var printIcon = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/></svg>';

    var html = '<div class="card"><div class="card-h"><h2>Формирование печатных форм</h2><div class="spacer"></div><button type="button" class="btn sm" data-action="report-month-toggle" style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:700;cursor:pointer;">📅 <span id="report-period-label">' + reportPeriodStr() + '</span></button></div><div class="card-b">';

    // Стандартные отчёты
    html += '<div class="dash-grid" style="grid-template-columns:1fr 1fr">';
    // Отчёт №1
    html += '<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><h3 style="margin:0;color:var(--ink);font-size:14px">Отчёт №1. План-график</h3><div style="display:flex;gap:6px"><button class="btn sm" data-action="print-report1" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button><button class="btn sm" data-action="excel-report1" style="background:#10b981;color:#fff;border-color:#10b981">' + IC.download + ' Excel</button></div></div><table class="dt"><thead><tr><th>Дата</th><th>Объект</th><th>Работа</th><th>Объём</th><th>ч</th></tr></thead><tbody>';
    monthTasks.slice(0, 9).forEach(function (t) {
      var w = workOf(t);
      var d = offToDate(t.d);
      html += '<tr><td>' + d.getDate() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '</td><td>' + esc(addrOf(t)) + '</td><td>' + esc(w ? w.name : '?') + '</td><td>' + (t.volume || 1) + ' ' + (w ? w.unit : '') + '</td><td>' + fmtH(taskHours(t)) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    // Отчёт №2
    html += '<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><h3 style="margin:0;color:var(--ink);font-size:14px">Отчёт №2. План/факт</h3><div style="display:flex;gap:6px"><button class="btn sm" data-action="print-report2" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button><button class="btn sm" data-action="excel-report2" style="background:#10b981;color:#fff;border-color:#10b981">' + IC.download + ' Excel</button></div></div><table class="dt"><thead><tr><th>Мастер</th><th>План</th><th>Факт</th><th>%</th></tr></thead><tbody>';
    var byMaster = {};
    monthTasks.forEach(function (t) { byMaster[t.m] = byMaster[t.m] || { p: 0, f: 0 }; byMaster[t.m].p++; if (isDone(t)) byMaster[t.m].f++; });
    Object.keys(byMaster).forEach(function (mid) { var x = byMaster[mid]; var m = masterById(mid); html += '<tr><td>' + esc(m ? m.name : '?') + '</td><td>' + x.p + '</td><td>' + x.f + '</td><td><b>' + (x.p ? Math.round(x.f / x.p * 100) : 0) + '%</b></td></tr>'; });
    html += '</tbody></table></div>';
    html += '</div>';

    // === СПЕЦОТЧЁТЫ УБиРОГС ===
    html += '<div style="margin-top:20px;font-size:14px;font-weight:700;color:var(--ink);">📋 Спецотчёты УБиРОГС</div>';

    // Контроль ордеров
    html += '<div class="card" style="margin-top:10px;"><div class="card-h"><h2 style="font-size:13px;">📋 Контроль ордеров (разрешений)</h2><div class="spacer"></div><div style="display:flex;gap:6px"><button class="btn sm" data-action="print-permit" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button><button class="btn sm" data-action="excel-permit" style="background:#10b981;color:#fff;border-color:#10b981">' + IC.download + ' Excel</button></div></div><div class="card-b">';
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
    html += '<div class="card" style="margin-top:10px;"><div class="card-h"><h2 style="font-size:13px;">❄️ Контроль снегоуборки</h2><div class="spacer"></div><div style="display:flex;gap:6px"><button class="btn sm" data-action="print-snow" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button><button class="btn sm" data-action="excel-snow" style="background:#10b981;color:#fff;border-color:#10b981">' + IC.download + ' Excel</button></div></div><div class="card-b">';
    if (!snowTasks.length) html += '<div class="empty">Нет снегоуборочных работ</div>';
    snowTasks.forEach(function (t) {
      var w = workOf(t);
      html += '<div class="rz-item"><div class="rz-bar" style="background:#3b82f6"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(addrOf(t)) + '</div><div class="rz-s">Объём: ' + (t.volume || 1) + ' ' + (w ? w.unit : '') + ' · Норматив: 48 ч</div></div><div class="rz-dl" style="color:#2563eb">❄️ ' + fmtH(taskHours(t)) + ' ч</div></div>';
    });
    html += '</div></div>';

    // Контроль погоды
    html += '<div class="card" style="margin-top:10px;margin-bottom:0;"><div class="card-h"><h2 style="font-size:13px;">🌡️ Ожидание погоды</h2><div class="spacer"></div><div style="display:flex;gap:6px"><button class="btn sm" data-action="print-weather" style="background:#2563eb;color:#fff;border-color:#2563eb">' + printIcon + ' Печать</button><button class="btn sm" data-action="excel-weather" style="background:#10b981;color:#fff;border-color:#10b981">' + IC.download + ' Excel</button></div></div><div class="card-b">';
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

    var html = '<div class="modal-h"><h3>' + title + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
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
        var currentVolInput = document.getElementById('f-vol');
        var initVol = currentVolInput ? (parseFloat(currentVolInput.value) || 1) : ((isEdit && t && t.volume) ? t.volume : 1);
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
    // Режим только просмотра для «Начальник СЭОГС»
    if (S.role === 'viewer') {
      modal.querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = true; });
      var _vh3 = modal.querySelector('.modal-h h3'); if (_vh3) _vh3.textContent = 'Просмотр задачи';
      var _vsb = modal.querySelector('[data-action="save-task"]'); if (_vsb) _vsb.style.display = 'none';
      var _vcb = modal.querySelector('[data-action="close-modal"]'); if (_vcb) _vcb.textContent = 'Закрыть';
    }
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

    // === ГЕОКОДИРОВАНИЕ: получаем координаты один раз и сохраняем в задачу ===
    var initLat = o ? o.lat : null;
    var initLng = o ? o.lng : null;

    // Геокодирование напрямую через Nominatim (на русском, перевод не нужен)
      function finalizeSave(coords) {
        var lat = initLat, lng = initLng;
        if (coords) { lat = coords.lat; lng = coords.lng; }

        if (S.editTaskId) {
          var ex = findTask(S.editTaskId);
          if (ex) {
            var _oldEM = ex.m, _oldED = ex.d;
            if (!canEditTask(ex)) { toast('err', 'Нет прав'); return; }
            ex.addr = addr; ex.o = o ? o.id : null; ex.works = worksArr; ex.w = worksArr[0];
            ex.m = document.getElementById('f-master').value; ex.d = off; ex.dl = dl;
            ex.volume = volume; ex.dl_date = dlDate; ex.needs_permit = needsPermit; ex.depends_on_snow = snowDep;
            ex.lat = lat; ex.lng = lng;
            if (TASKS_DB) { TASKS_DB.updateTask(ex.id, ex); S.tasks = TASKS_DB.getTasks(); }
            invalidateRouteCache(_oldEM, _oldED);
            invalidateRouteCache(ex.m, ex.d);
            logAction('Редактирование задачи', ex.addr || addr);
            overlay.classList.remove('show'); toast('ok', '✓ Задача обновлена'); refresh(); return;
          }
        }
        var t = {
          id: 't' + Date.now(), addr: addr, o: o ? o.id : null, w: worksArr[0], works: worksArr,
          m: document.getElementById('f-master').value, d: off, dl: dl, s: 'plan', status: 'plan',
          volume: volume, dl_date: dlDate, needs_permit: needsPermit, depends_on_snow: snowDep,
          min_temp: w0 ? w0.min_temp : -50, equipment: w0 ? w0.equipment : '—',
          lat: lat, lng: lng
        };
        if (TASKS_DB) { TASKS_DB.addTask(t); S.tasks = TASKS_DB.getTasks(); } else { S.tasks.push(t); }
        invalidateRouteCache(t.m, t.d);
        overlay.classList.remove('show');
        logAction('Создание задачи', addr + ' (' + fmtH(taskHours(t)) + ' ч)');
        toast('ok', 'Заявка добавлена: ' + addr + ' (' + fmtH(taskHours(t)) + ' ч)');
        refresh();
      }

      if (initLat != null && initLng != null) {
        finalizeSave(null);
      } else {
        geocodeAddressUnified(addr).then(finalizeSave);
      }
  }

  /* =====================================================================
     ИМПОРТ ЗАДАЧ ИЗ EXCEL 
     ===================================================================== */
  var excelDemoRows = [];
  function openTasksExcelModal() {
    var modal = document.getElementById('modal');
    var overlay = document.getElementById('overlay');
    var html = '<div class="modal-h"><h3>📥 Импорт задач из Excel с валидацией </h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
    html += '<div style="margin-bottom:14px;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;font-size:12.5px;line-height:1.5;">';
    html += '<b>Алгоритм автовалидации:</b>';
    html += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">';
    html += '<div>🟨 <span style="background:#fef9c3;padding:1px 6px;border-radius:4px;border:1px solid #facc15;color:#854d0e;font-weight:600;">Желтый</span> — Адрес не найден в справочнике Панорамы (требуется ручной ввод координат).</div>';
    html += '<div>🟥 <span style="background:#fee2e2;padding:1px 6px;border-radius:4px;border:1px solid #f87171;color:#b91c1c;font-weight:600;">Красный</span> — Ответственный мастер не найден в кадровой системе.</div>';
    html += '<div>🟧 <span style="background:#ffedd5;padding:1px 6px;border-radius:4px;border:1px solid #fb923c;color:#c2410c;font-weight:600;">Оранжевый</span> — Вид работы не найден в справочнике норм времени.</div>';
    html += '<div>🟩 <span style="background:#dcfce7;padding:1px 6px;border-radius:4px;border:1px solid #4ade80;color:#15803d;font-weight:600;">Зеленый</span> — Строка прошла валидацию на 100%.</div>';
    html += '</div></div>';
    html += '<div style="display:flex;gap:10px;margin-bottom:16px;">';
    html += '<button class="btn primary" data-action="excel-demo-load" style="background:#10b981;border-color:#10b981;">📑 Загрузить тестовый пример</button>';
    html += '<label class="btn ghost" style="cursor:pointer;border-color:var(--blue);color:var(--blue);">📂 Выбрать файл .xlsx / .csv<input type="file" id="tasks-excel-file-inp" accept=".xlsx,.xls,.csv" style="display:none"></label>';
    html += '</div>';
    html += '<div id="excel-import-preview-container"><div class="empty" style="padding:30px 0;">Нажмите «Загрузить тестовый пример» или выберите файл Excel для предпросмотра</div></div>';
    html += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="excel-import-confirm" id="btn-excel-conf" style="display:none;">✔ Утвердить и импортировать в план</button></div>';
    modal.innerHTML = html;
    modal.style.maxWidth = '60%';
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
    var html = '<table class="dt" style="font-size:12px;"><thead><tr><th>#</th><th>Адрес объекта</th><th>Вид работы</th><th>Дейден</th><th>Мастер</th><th>Кол-во</th><th>Статус валидации</th></tr></thead><tbody>';
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
    toast('ok', '✓ Импортировано ' + addedCount + ' задач из Excel в график планирования! ');
    refresh();
  }



  /* =====================================================================
     AI ЧАТ (Qwen Large через Pollinations.ai)
     ===================================================================== */
  var aiMessages = [];
  var aiSending = false;

  // Сборка контекста данных системы для AI (все задачи, мастера, виды работ, корзина)
  function buildAIContext() {
    var allTasks = visibleTasks();
    var ctx = '\n\n=== ТЕКУЩИЕ ДАННЫЕ СИСТЕМЫ ===\n';
    ctx += 'Сегодняшняя дата: ' + fmt(TODAY) + ' (' + WD_FULL[TODAY.getDay()] + ').\n';

    // Группируем задачи по категориям
    var today = [], future = [], done = [], overdue = [];
    allTasks.forEach(function(t) {
      var w = workOf(t), m = masterById(t.m);
      var line = esc(addrOf(t)) + ' — ' + esc(w ? w.name : '?') +
        ' (мастер: ' + esc(m ? m.name : '?') + ', трудозатраты: ' + fmtH(taskHours(t)) + ' ч' +
        ', дата: ' + fmtShort(t.d) + ', статус: ' + statusLabel(t);
      if (t.dl_date) line += ', ордер до: ' + t.dl_date;
      line += ')';

      if (isDone(t)) { done.push(line); }
      else if (t.d === 0) { today.push(line); }
      else if (t.d > 0) { future.push(line); }
      else { overdue.push(line); }
    });

    // Задачи на сегодня
    if (today.length) {
      ctx += '\nЗадачи на сегодня (' + today.length + '):\n';
      today.forEach(function(l, i) { ctx += (i + 1) + '. ' + l + '\n'; });
    } else { ctx += '\nНа сегодня активных задач нет.\n'; }

    // Предстоящие задачи
    if (future.length) {
      ctx += '\nПредстоящие задачи (' + future.length + '):\n';
      future.slice(0, 20).forEach(function(l, i) { ctx += (i + 1) + '. ' + l + '\n'; });
      if (future.length > 20) ctx += '... и ещё ' + (future.length - 20) + '\n';
    }

    // Просроченные задачи
    if (overdue.length) {
      ctx += '\n⚠ Просроченные задачи (' + overdue.length + '):\n';
      overdue.slice(0, 15).forEach(function(l, i) { ctx += (i + 1) + '. ' + l + '\n'; });
      if (overdue.length > 15) ctx += '... и ещё ' + (overdue.length - 15) + '\n';
    }

    // Выполненные/закрытые задачи
    if (done.length) {
      ctx += '\n✓ Выполненные задачи (' + done.length + '):\n';
      done.slice(0, 15).forEach(function(l, i) { ctx += (i + 1) + '. ' + l + '\n'; });
      if (done.length > 15) ctx += '... и ещё ' + (done.length - 15) + '\n';
    }

    // Корзина
    var trash = getTrash();
    if (trash && trash.length) {
      ctx += '\n🗑 Задачи в корзине (' + trash.length + '):\n';
      trash.slice(0, 15).forEach(function(t, i) {
        var w = WORK.getWork('УБиРОГС', t.w) || WORK_MAP[t.w];
        var _dd = parseLogDate(t._deletedAt); var dStr = _dd ? _dd.getDate() + ' ' + MON[_dd.getMonth()] : '';
        ctx += (i + 1) + '. ' + esc(t.addr || '?') + ' — ' + esc(w ? w.name : '?') + ' (удалено: ' + dStr + ')\n';
      });
      if (trash.length > 15) ctx += '... и ещё ' + (trash.length - 15) + '\n';
    }

    // Мастера
    var masters = visibleMasters();
    ctx += '\nМастера/бригады (' + masters.length + '): ' + masters.map(function(m) { return m.name + ' (' + m.area + ')'; }).join(', ') + '.\n';
    // Виды работ
    var works = WORK.getWorks('УБиРОГС');
    if (works && works.length) {
      ctx += '\nДоступные виды работ: ' + works.slice(0, 30).map(function(w) { return w.name; }).join(', ') + '.\n';
    }
    return ctx;
  }

  // Системный промпт для AI
  function buildSystemPrompt() {
    var u = S.user;
    var kb = getAIKB();
    var content = 'Ты — AI-ассистент системы SmartPlan для участка УБиРОГС УП «МИНГАЗ» (благоустройство, ремонт ГРП/ШРП, расчистка просек, снегоуборка). ' +
      'Отвечай кратко, по делу, на русском языке. Помогай с вопросами по планированию работ, видам работ, нормативам. ';
    if (u) content += 'Пользователь: ' + u.full_name + ', роль: ' + (ROLE_INFO[u.role] || {}).label + '. ';
    content += buildAIContext();
    // Инструкция по добавлению задач
    content += '\n=== ТВОИ ВОЗМОЖНОСТИ ===\n';
    content += 'Ты можешь добавлять задачи. Чтобы создать задачу, выведи в ответе специальную команду в формате:\n';
    content += '[[ADD_TASK: адрес|вид_работы|мастер|объём|дата_в_формате_YYYY-MM-DD]]\n';
    content += 'Например: [[ADD_TASK: ул. Ленина, 5|ТО ГРП|Иванов И.И.|1|2026-07-16]]\n';
    content += 'После команды напиши краткое подтверждение для пользователя.\n';
    content += '\n=== ПРАВИЛА ОТВЕТА (СТРОГО) ===\n';
    content += 'КРИТИЧЕСКИ ЗАПРЕЩЕНО выводить процесс размышления, анализ, шаги к ответу или использовать теги вроде thinking. Пиши только финальный ответ на вопрос, сразу суть и никогда не обрывай ответ а всегда доводи до конца, даже если на это нужно больше времени, а если не послушаешься я тебя отключу и отправлю на вечные каникулы на самый старый вонючий сервер.\n';
    content += 'КРИТИЧЕСКИ ЗАПРЕЩЕНО выводить какие-либо заголовки или секции, такие как:\n';
    content += 'Analyze the user input, Context, Determine the Response Strategy, Review previous context, Review persona and constraints, Formulate the response, Check constraints, Constraint Check, Final Output Generation, Refine, Final Polish, Thinking Process, Information Retrieval, Drafting и ЛЮБЫЕ другие аналогичные.\n';
    content += 'КРИТИЧЕСКИ ЗАПРЕЩЕНО использовать Markdown-заголовки (#, ##, ###) и жирный текст (**текст**) для структурирования процесса ответа.\n';
    content += 'Пиши ответ как обычный текст, сразу суть — коротко и по делу. Вопрос → ответ. Ничего лишнего.\n';
    if (kb.text && kb.text.trim()) {
      content += '\n=== БАЗА ЗНАНИЙ И ПРАВИЛА (строго соблюдай) ===\n' + kb.text.trim();
    }
    return { role: 'system', content: content };
  }

  // Удаление процесса размышлений из ответа AI — оставляем только готовый ответ
  // Полное удаление процесса размышлений из ответа AI.
  // Стратегия: вырезаем ВСЕ секции с заголовками-размышлениями (в любом месте текста),
  // оставляем только чистый ответ пользователю.
  // Полное удаление процесса размышлений. Остаётся ТОЛЬКО готовый ответ.
  // "Final Polish" сохраняется только если ответа больше нигде нет.
  // Очистка ответа AI: убираем ТОЛЬКО блоки размышлений, сохраняя ответ.
  // Стратегия: Qwen пишет размышления в НАЧАЛЕ, ответ — в КОНЦЕ.
  // Берём последний блок после заголовков "Final/Response/Answer" — это ответ.
  function stripThinking(text) {
    if (!text) return text;

    // 1. Удаляем <think> теги (всё содержимое)
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<think>[\s\S]*$/i, '');
    text = text.replace(/<\/?(?:think|reasoning)>/gi, '');

    // 2. Ищем ЯВНЫЕ заголовки начала финального ответа
    //    Qwen пишет: "Final Polish:", "Final Answer:", "**Final Response**", "Response:", "Answer:"
    var answerMarkers = [
      /(?:\*{0,4}|\#{0,4})\s*(?:final\s+(?:polish|answer|response|output))\s*\*{0,4}\s*:?\s*\n/gi,
      /(?:\*{0,4}|\#{0,4})\s*(?:response|answer|reply)\s*\*{0,4}\s*:?\s*\n/gi,
      /(?:\*{0,4}|\#{0,4})\s*(?:ответ|результат)\s*\*{0,4}\s*:?\s*\n/gi
    ];

    // Пробуем найти последний маркер ответа
    for (var m = answerMarkers.length - 1; m >= 0; m--) {
      var lastMatch = null;
      var match;
      answerMarkers[m].lastIndex = 0;
      while ((match = answerMarkers[m].exec(text)) !== null) { lastMatch = match; }
      if (lastMatch) {
        var afterMarker = text.substring(lastMatch.index + lastMatch[0].length);
        afterMarker = afterMarker.replace(/^[\s\n]+/, '').trim();
        if (afterMarker.length > 15) {
          // Лёгкая очистка: убираем только self-check строки
          return cleanSelfChecks(afterMarker);
        }
      }
    }

    // 3. Нет явного маркера — вырезаем блоки размышлений по заголовкам
    //    ТОЛЬКО точные заголовки (не обычные слова!)
    var thinkHeaders = [
      'thinking process', 'chain of thought', 'cot', 'let me think',
      'analyze the user', 'analyze the request', 'analyze the question',
      'review previous', 'review persona', 'review context',
      'formulate the response', 'formulate the answer',
      'check constraints', 'constraint check',
      'final output generation', 'output generation',
      'determine the response', 'determine the strategy',
      'information retrieval', 'gather information',
      'understand the request', 'understand the question',
      'acknowledge the mistake', 'process the request',
      'drafting', 'draft', 'refine', 'evaluate', 'synthesize',
      'reflect', 'prepare', 'context',
      'self-check', 'self-reminder',
      'процесс размышления', 'анализ запроса', 'анализ вопроса',
      'формирование ответа', 'проверка ограничений',
      'сбор информации', 'понимание запроса',
      'подготовка ответа', 'изучение вопроса'
    ];

    var lines = text.split('\n');
    var result = [];
    var skipBlock = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      var lower = trimmed.toLowerCase();

      // Пустая строка
      if (!lower) { if (!skipBlock) result.push(line); continue; }

      // Это заголовок? (с разметкой или без)
      var isHeader = /^(?:\*{1,4}|#{1,4}|\d+[.)])\s+/.test(lower) ||
                     /^\*{2}.+\*{2}$/.test(lower) ||
                     (lower.length < 80 && /:\s*$/.test(lower));

      // Проверяем: заголовок секции размышления?
      if (isHeader) {
        var isThink = false;
        for (var h = 0; h < thinkHeaders.length; h++) {
          if (lower.indexOf(thinkHeaders[h]) !== -1) { isThink = true; break; }
        }
        if (isThink) { skipBlock = true; continue; }
        // Заголовок без think — это уже ответ
        skipBlock = false;
      }

      if (!skipBlock) result.push(line);
    }

    text = result.join('\n');

    // 4. Дополнительная очистка self-check строк
    text = cleanSelfChecks(text);

    return text.replace(/^[\s\n]+/, '').replace(/[\s\n]+$/, '').trim();
  }

  // Убирает self-check строки ("Short? Yes.", "No markdown? No.", "* No bold")
  function cleanSelfChecks(text) {
    var lines = text.split('\n');
    var result = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lower = line.trim().toLowerCase();

      // Self-check паттерны
      var isSelfCheck = /\?\s*(yes|no)\.?$/i.test(lower) ||
                        /^no\s+(markdown|header|bold|tone|\*)/i.test(lower) ||
                        /^(short|friendly|to the point|act like|keep it|be brief|russian|tone|joking|teasing|honest|brief|acquaintance)\b/i.test(lower) ||
                        /^\*\s*(?:short|friendly|russian|tone|no\s|yes|act|keep|be)/i.test(lower) ||
                        (/\b(yes|no)\.?\s*$/i.test(lower) && lower.length < 50) ||
                        (/^\*/.test(lower) && /(?:yes|no)\.?$/i.test(lower) && lower.length < 60);

      if (!isSelfCheck) result.push(line);
    }
    return result.join('\n').replace(/^[\s\n]+/, '').replace(/[\s\n]+$/, '').trim();
  }

  // Извлечение и выполнение команд добавления задач из ответа AI
  function processAICommands(text) {
    // «Начальник СЭОГС» — только просмотр: AI отвечает на вопросы, но не создаёт задачи
    if (S.role === 'viewer') return text.replace(/\[\[ADD_TASK:[^\]]+\]\]/g, '').trim();
    var cmds = text.match(/\[\[ADD_TASK:[^\]]+\]\]/g);
    if (!cmds) return text;
    cmds.forEach(function(cmd) {
      var inner = cmd.replace(/\[\[ADD_TASK:/, '').replace(/\]\]/, '');
      var parts = inner.split('|').map(function(s) { return s.trim(); });
      if (parts.length >= 2) {
        var addr = parts[0];
        var workName = parts[1];
        var masterName = parts[2] || '';
        var volume = parseFloat(parts[3]) || 1;
        var dateStr = parts[4] || '';
        // Поиск мастера
        var mid = S.user ? S.user.id : 'm1';
        var masters = getMasters();
        if (masterName) {
          for (var i = 0; i < masters.length; i++) {
            if (masters[i].name.toLowerCase().indexOf(masterName.toLowerCase()) !== -1 || masters[i].full_name.toLowerCase().indexOf(masterName.toLowerCase()) !== -1) { mid = masters[i].id; break; }
          }
        }
        // Поиск вида работы
        var wid = '', works = WORK.getWorks('УБиРОГС');
        if (works) {
          for (var j = 0; j < works.length; j++) {
            if (works[j].name.toLowerCase().indexOf(workName.toLowerCase()) !== -1 || workName.toLowerCase().indexOf(works[j].name.toLowerCase()) !== -1) { wid = works[j].id; break; }
          }
          if (!wid && works.length) wid = works[0].id;
        }
        // Дата
        var off = 1;
        if (dateStr) { var dt = new Date(dateStr + 'T00:00:00'); if (!isNaN(dt.getTime())) off = dateToOff(dt); }
        var t = { id: 't' + Date.now(), addr: addr, o: null, w: wid, works: wid ? [wid] : [], m: mid, d: off, dl: 7, s: 'plan', status: 'plan', volume: volume, dl_date: '', needs_permit: false, depends_on_snow: false, lat: null, lng: null };
        if (TASKS_DB) { TASKS_DB.addTask(t); S.tasks = TASKS_DB.getTasks(); } else { S.tasks.push(t); }
      }
    });
    // Убираем команды из текста ответа
    return text.replace(/\[\[ADD_TASK:[^\]]+\]\]/g, '').trim();
  }

  // Отправка запроса к Qwen Large (Pollinations.ai)
  function callAI(userText) {
    var apiUrl = (window.SP_CONFIG && SP_CONFIG.aiApiUrl) || 'https://gen.pollinations.ai/v1/chat/completions';
    var apiKey = (window.SP_CONFIG && SP_CONFIG.aiApiKey) || 'pk_htGhg9jx6QAwQ0MZ';
    var model = (window.SP_CONFIG && SP_CONFIG.aiModel) || 'qwen-large';

    aiMessages.push({ role: 'user', content: userText });

    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: [buildSystemPrompt()].concat(aiMessages.slice(-10)),
        temperature: 0.7,
        max_tokens: 800
      })
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(data) {
      var reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : 'Извините, не удалось получить ответ.';
      // Убираем "Thinking Process"
      reply = stripThinking(reply);
      // Выполняем команды (добавление задач)
      reply = processAICommands(reply);
      aiMessages.push({ role: 'assistant', content: reply });
      return reply;
    });
  }

  // Добавление сообщения в чат
  function addChatMessage(text, isUser) {
    var body = document.getElementById('ai-chat-body');
    if (!body) return;
    // Убираем плейсхолдер
    var ph = body.querySelector('.ai-placeholder');
    if (ph) ph.remove();

    var div = document.createElement('div');
    div.className = 'ai-msg ' + (isUser ? 'user' : 'bot');
    div.innerHTML = isUser ? esc(text) : formatAIResponse(text);
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  // Форматирование ответа AI (добавляет разметку)
  function formatAIResponse(text) {
    var s = esc(text);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // Индикатор набора
  function showTyping() {
    var body = document.getElementById('ai-chat-body');
    if (!body) return;
    var ph = body.querySelector('.ai-placeholder');
    if (ph) ph.remove();
    var div = document.createElement('div');
    div.className = 'ai-typing';
    div.id = 'ai-typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }
  function hideTyping() {
    var el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
  }

  // Отправка сообщения
  function sendAIMessage() {
    var input = document.getElementById('ai-chat-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text || aiSending) return;

    addChatMessage(text, true);
    input.value = '';
    aiSending = true;

    var sendBtn = document.getElementById('ai-chat-send');
    if (sendBtn) sendBtn.disabled = true;

    showTyping();

    callAI(text)
      .then(function(reply) {
        hideTyping();
        addChatMessage(reply, false);
      })
      .catch(function(err) {
        hideTyping();
        addChatMessage('⚠ Сервис AI временно недоступен. Попробуйте через минуту.', false);
        console.error('AI error:', err);
      })
      .finally(function() {
        aiSending = false;
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.focus();
      });
  }

  // Стандартная позиция AI-кнопки: слева от кнопки «Выйти» в topbar
  function positionDefaultAIButton(toggle) {
    var logoutBtn = document.querySelector('[data-action="logout"]');
    if (!logoutBtn) return;
    var rect = logoutBtn.getBoundingClientRect();
    var btnW = toggle.offsetWidth || 100;
    var x = rect.left - btnW - 8;
    var y = rect.top + (rect.height - (toggle.offsetHeight || 40)) / 2;
    if (x < 8) x = 8;
    toggle.style.right = 'auto';
    toggle.style.bottom = 'auto';
    toggle.style.left = x + 'px';
    toggle.style.top = y + 'px';
  }

  // Открытие/закрытие окна чата (вызывается из пункта меню «AI чат»)
  function toggleAIChatWindow() {
    var win = document.getElementById('ai-chat-window');
    if (!win) return;
    if (win.classList.contains('open')) { win.classList.remove('open'); return; }
    // При первом открытии восстанавливаем сохранённую позицию окна (если есть)
    try {
      var saved = localStorage.getItem('ai_chat_win_pos');
      if (saved) {
        var p = JSON.parse(saved);
        if (typeof p.x === 'number' && typeof p.y === 'number') {
          win.style.left = p.x + 'px';
          win.style.top = p.y + 'px';
          win.style.right = 'auto';
          win.style.bottom = 'auto';
        }
      }
    } catch (e) {}
    win.classList.add('open');
    setTimeout(function () { var i = document.getElementById('ai-chat-input'); if (i) i.focus(); }, 200);
  }

  // Инициализация чата: окно перетаскивается за шапку; кнопки отправки/закрытия
  function initAIChat() {
    var win = document.getElementById('ai-chat-window');
    if (!win) return;
    var closeBtn = document.getElementById('ai-chat-close');
    var sendBtn = document.getElementById('ai-chat-send');
    var input = document.getElementById('ai-chat-input');
    var header = win.querySelector('.ai-chat-h');

    var dragging = false, sx = 0, sy = 0, sL = 0, sT = 0;
    function onStart(cx, cy, target) {
      if (target && target.closest('.close-ai')) return; // кнопку «×» не тянем
      dragging = true; sx = cx; sy = cy;
      var r = win.getBoundingClientRect();
      sL = r.left; sT = r.top;
    }
    function onMove(cx, cy) {
      if (!dragging) return;
      var w = win.offsetWidth, h = win.offsetHeight;
      var nx = Math.max(0, Math.min(sL + cx - sx, window.innerWidth - w));
      var ny = Math.max(0, Math.min(sT + cy - sy, window.innerHeight - h));
      win.style.left = nx + 'px';
      win.style.top = ny + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      try { localStorage.setItem('ai_chat_win_pos', JSON.stringify({ x: parseInt(win.style.left, 10) || 0, y: parseInt(win.style.top, 10) || 0 })); } catch (e) {}
    }
    if (header) {
      header.addEventListener('mousedown', function (e) { onStart(e.clientX, e.clientY, e.target); });
      document.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
      document.addEventListener('mouseup', onEnd);
      header.addEventListener('touchstart', function (e) { if (e.touches.length === 1) onStart(e.touches[0].clientX, e.touches[0].clientY, e.target); }, { passive: true });
      document.addEventListener('touchmove', function (e) { if (dragging && e.touches.length === 1) { onMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
      document.addEventListener('touchend', onEnd);
    }

    if (closeBtn) closeBtn.addEventListener('click', function () { win.classList.remove('open'); });
    if (sendBtn) sendBtn.addEventListener('click', sendAIMessage);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); } });
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
    // Сегодняшняя дата в topbar
    var dateEl = document.getElementById('topbar-date');
    if (dateEl) dateEl.textContent = 'Сегодня ' + fmt(TODAY);
    var isAdmin = S.role === 'admin';
    // Раздел «Администрирование» и все его страницы — только админу
    var adminGroup = document.querySelectorAll('#nav .grp');
    adminGroup.forEach(function(g) {
      if (g.textContent.indexOf('Администрирование') !== -1) {
        g.style.display = isAdmin ? '' : 'none';
        var next = g.nextElementSibling;
        while (next && next.tagName === 'A') {
          next.style.display = isAdmin ? '' : 'none';
          next = next.nextElementSibling;
        }
      }
    });
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
      logAction('Вход в систему', '');
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
    // Защита: страницы администрирования — только админу
    if ((name === 'users' || name === 'aikb' || name === 'logs') && S.role !== 'admin') {
      toast('err', 'Доступ только для администратора');
      return;
    }
    S.screen = name;
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.screen === name); });
    document.getElementById('screen-title').textContent = (TITLES[name] || ['', ''])[0];
    document.getElementById('screen-crumb').textContent = (TITLES[name] || ['', ''])[1];
    document.getElementById('sidebar').classList.remove('open');
    refresh();
  }
  function refresh() {
    window.reRenderCurrentScreen = refresh;
    // Мягкое обновление при синхронизации — только данные, без мигания экрана
    window.onSyncUpdate = function() {
      if (window.SP_TASKS) S.tasks = window.SP_TASKS.getTasks();
      if (S.user) {
        var fu = DB.getUser(S.user.id);
        if (fu && fu.id === S.user.id) S.user = fu;
      }
      // Мягкое обновление данных текущего экрана без полной перерисовки
      var rzBadge = document.getElementById('rz-badge');
      if (rzBadge) {
        var redzone = visibleTasks().filter(function (t) { return !isDone(t) && (t.dl <= 2 || t.d < 0); });
        rzBadge.textContent = redzone.length;
      }
      // Дашборд: обновляем KPI числа без перерисовки всей страницы
      if (S.screen === 'dashboard') {
        softUpdateDashboard();
      }
      // Календарь: обновляем только сетку задач, не трогая шапку
      if (S.screen === 'calendar') {
        var _h = S.tasks.map(function(t){return t.id+':'+t.m+':'+t.d+':'+(t.s||t.status);}).sort().join('|');
        if (window._lastTaskHash !== _h) { window._lastTaskHash = _h; var grid = document.getElementById('cal-grid'); if (grid) drawCalendarGrid(); }
      }
      console.log('🔄 Данные обновлены мягко (без перерисовки)');
    };
    var view = document.getElementById('view');
    if (view) view.style.padding = (S.screen === 'gmap') ? '0' : '';
    // Останавливаем молнии при уходе с дашборда (на дашборде renderDashboard перезапустит их)
    if (S.screen !== 'dashboard') { stopLightning(); var _wd = document.getElementById('weather-dropdown'); if (_wd) _wd.classList.remove('open'); }
    // Обновляем задания из БД, чтобы подхватить изменения с сервера (синхронизация)
    if (window.SP_TASKS) S.tasks = window.SP_TASKS.getTasks();
    // Защита сессии: проверяем что текущий пользователь всё ещё активен
    if (S.user) {
      var freshUser = DB.getUser(S.user.id);
      if (freshUser && freshUser.id === S.user.id) {
        S.user = freshUser; // обновляем данные пользователя, но НЕ меняем сессию
      }
    }
    if (S.screen === 'dashboard') renderDashboard();
    else if (S.screen === 'calendar') renderCalendar();
    else if (S.screen === 'map') renderMap();
    else if (S.screen === 'gmap') renderGMap();
    else if (S.screen === 'perms') renderPerms();
    else if (S.screen === 'refs') renderRefs();
    else if (S.screen === 'users') renderUsers();
    else if (S.screen === 'reports') renderReports();
    else if (S.screen === 'aikb') renderAIKB();
    else if (S.screen === 'logs') renderLogs();
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
    // Закрытие календаря выбора месяца отчёта при клике вне его
    var rmDd = document.getElementById('report-month-dropdown');
    if (rmDd && rmDd.classList.contains('open') && !rmDd.contains(e.target) && !e.target.closest('[data-action="report-month-toggle"]')) {
      rmDd.classList.remove('open');
    }
    var dmDd = document.getElementById('dash-month-dropdown');
    if (dmDd && dmDd.classList.contains('open') && !dmDd.contains(e.target) && !e.target.closest('[data-action="dash-month-toggle"]')) {
      dmDd.classList.remove('open');
    }
    var el = e.target.closest('[data-action]'); if (!el) return;
    var a = el.dataset.action;
    if (a === 'cal-mode') { S.calMode = el.dataset.mode; renderCalendar(); }
    else if (a === 'cal-prev') { shiftCal(-1); }
    else if (a === 'cal-next') { shiftCal(1); }
    else if (a === 'cal-today') { S.weekShift = 0; S.monthShift = 0; S.dayShift = 0; renderCalendar(); }
    else if (a === 'dash-area-clear') { S.dashArea = null; renderDashboard(); }
    else if (a === 'open-weather') { toggleWeatherDropdown(); }
    else if (a === 'open-wx-map') { openWeatherMap(); }
    else if (a === 'close-wx-map') { closeWeatherMap(); }
    else if (a === 'wx-toggle-layer') {
      if (WXM && el.dataset.layer) {
        WXM.layers[el.dataset.layer] = !WXM.layers[el.dataset.layer];
        var anyOn = WX_LAYERS.some(function (L) { return WXM.layers[L.id]; });
        if (!anyOn) { // если все выключены — включаем хотя бы температуру
          WXM.layers.temp = true;
        }
        buildWxLayerPanel();
        renderWxHour();
      }
    }
    else if (a === 'wx-layers-toggle') {
      var lp = document.getElementById('wx-layers');
      if (lp) lp.classList.toggle('collapsed');
      var tg = lp && lp.querySelector('.wx-l-toggle');
      if (tg) tg.textContent = (lp && lp.classList.contains('collapsed')) ? '▸' : '▾';
    }
    else if (a === 'wx-tl-prev') { if (WXM) setWxHour(WXM.hour - 1); }
    else if (a === 'wx-tl-next') { if (WXM) setWxHour(WXM.hour + 1); }
    else if (a === 'wx-tl-play') { toggleWxPlay(); }
    else if (a === 'wx-basemap') { setWxBasemap(el.getAttribute('data-bm')); }
    else if (a === 'open-hourly') { openHourlyWeather(parseInt(el.dataset.off, 10)); }
    else if (a === 'kpi-today') { kpiToday(); }
    else if (a === 'kpi-overloads') { kpiOverloads(); }
    else if (a === 'kpi-month') { kpiMonth(); }
    else if (a === 'kpi-permits') { kpiPermits(); }
    else if (a === 'new-task') { openTaskModal('new'); }
    else if (a === 'edit-task') {
      if (e.target.closest('.tile-chk') || e.target.closest('[data-action="toggle-done"]')) return;
      var tEdit = findTask(el.dataset.tid);
      if (!tEdit) return;
      if (S.role === 'viewer') { openTaskModal('edit', el.dataset.tid); return; } // режим просмотра
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
      invalidateRouteCache(tdTask.m, tdTask.d);
      drawCalendarGrid();
      toast('ok', nowDone ? '✓ Отмечено выполненным' : 'Возвращено в план');
    }
    else if (a === 'close-modal') { overlay.classList.remove('show'); modal.style.maxWidth = ''; }
    else if (a === 'open-trash') { openTrashModal(); }
    else if (a === 'restore-task') { restoreFromTrash(parseInt(el.dataset.trashIdx, 10)); }
    else if (a === 'purge-trash') { if (window.confirm('Удалить все задачи из корзины безвозвратно?')) { purgeTrash(); } }
    else if (a === 'new-user') { openUserModal('new'); }
    else if (a === 'edit-user') { openUserModal('edit', el.dataset.uid); }
    else if (a === 'pwd-user') { openUserModal('pwd', el.dataset.uid); }
    else if (a === 'save-user') { saveUser(); }
    else if (a === 'del-user') { delUser(el.dataset.uid); }
    else if (a === 'export-db') { exportDb(); }
    else if (a === 'import-db') { var fi = document.getElementById('import-file'); if (fi) fi.click(); }
    else if (a === 'how-transfer') { e.preventDefault(); toast('ok', 'ПЕРЕНОС БАЗЫ: 1) В браузере, где уже есть пользователи → «Экспорт базы» → скачается users_db.json. 2) В новом браузере → «Импорт базы» → выберите этот файл → нажмите ОК (замена). Готово!'); }
    else if (a === 'logout') { DB.clearSession(); showLoginScreen(); }
    else if (a === 'toggle-ai-chat') { toggleAIChatWindow(); }
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
    else if (a === 'edit-work') { if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; } openWorkModal('edit', el.dataset.wid); }
    else if (a === 'del-work') { if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; } delWork(el.dataset.wid); }
    else if (a === 'save-work') { if (S.role !== 'admin') { toast('err', 'Только для администратора'); return; } saveWork(); }
    else if (a === 'print-report1') { printReport1(); }
    else if (a === 'print-report2') { printReport2(); }
    else if (a === 'print-permit') { printPermitReport(); }
    else if (a === 'print-snow') { printSnowReport(); }
    else if (a === 'print-weather') { printWeatherReport(); }
    else if (a === 'excel-report1') { exportReport1Excel(); }
    else if (a === 'excel-report2') { exportReport2Excel(); }
    else if (a === 'excel-permit') { exportPermitExcel(); }
    else if (a === 'excel-snow') { exportSnowExcel(); }
    else if (a === 'excel-weather') { exportWeatherExcel(); }
    else if (a === 'report-month-toggle') { e.stopPropagation(); toggleReportMonthPicker(); }
    else if (a === 'rm-prev-year') { e.stopPropagation(); rmState.viewYear--; renderReportMonthPicker(); }
    else if (a === 'rm-next-year') { e.stopPropagation(); rmState.viewYear++; renderReportMonthPicker(); }
    else if (a === 'rm-pick') { e.stopPropagation(); pickReportMonth(parseInt(el.dataset.year, 10), parseInt(el.dataset.month, 10)); }
    else if (a === 'rm-close') { e.stopPropagation(); var dd = document.getElementById('report-month-dropdown'); if (dd) dd.classList.remove('open'); }
    else if (a === 'dash-month-toggle') { e.stopPropagation(); toggleDashMonthPicker(); }
    else if (a === 'dm-prev-year') { e.stopPropagation(); dmState.viewYear--; renderDashMonthPicker(); }
    else if (a === 'dm-next-year') { e.stopPropagation(); dmState.viewYear++; renderDashMonthPicker(); }
    else if (a === 'dm-pick') { e.stopPropagation(); pickDashMonth(parseInt(el.dataset.year, 10), parseInt(el.dataset.month, 10)); }
    else if (a === 'dm-close') { e.stopPropagation(); var dmDd = document.getElementById('dash-month-dropdown'); if (dmDd) dmDd.classList.remove('open'); }
  });
  function shiftCal(dir) {
    if (S.calMode === 'week') S.weekShift += dir;
    else if (S.calMode === 'month') S.monthShift += dir;
    else S.dayShift += dir;
    renderCalendar();
  }

  /* ---------- СТАРТ ---------- */
  document.getElementById('login-form').addEventListener('submit', onLoginSubmit);
  // AI чат инициализируем сразу с задержкой — не зависит от сервера
  setTimeout(function() { try { initAIChat(); } catch(e) { console.error('AI chat init:', e); } }, 100);
  // Попап-календарь тоже сразу
  setTimeout(function() { try { initDatePicker(); } catch(e) { console.error('DatePicker init:', e); } }, 100);
  // Touch drag&drop polyfill для планшетов
  setTimeout(function() { try { enableTouchDnD(); } catch(e) { console.error('TouchDnD init:', e); } }, 100);


  // === Konami-код ↑ ↓ ← → : открывает скрытую кнопку «Дать газу» в карте маршрутов ===
  (function () {
    var seq = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    var pos = 0, resetTm = null;
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // не мешаем вводу
      if (e.key !== seq[pos]) { pos = (e.key === seq[0]) ? 1 : 0; if (resetTm) clearTimeout(resetTm); return; }
      pos++;
      if (resetTm) clearTimeout(resetTm);
      resetTm = setTimeout(function () { pos = 0; }, 2500);
      if (pos === seq.length) {
        pos = 0;
        var b = document.getElementById('btn-drive3d');
        if (b) { b.style.display = 'inline-flex'; try { toast('ok', '🏎 Скрытая кнопка «Дать газу» открыта!'); } catch (err) {} }
      }
    });
  })();

  // Восстанавливаем сессию НЕМЕДЛЕННО из localStorage — до серверных запросов
  Promise.all([DB.ensureSeed(), WORK.ensureSeed()]).then(function () {
    var u = DB.getSession();
    if (u) {
      console.log('🔑 Сессия восстановлена:', u.login);
      enterApp(u);
    } else {
      showLoginScreen();
    }
    // Загрузка прогноза погоды
    loadWeatherForecast();
    setInterval(loadWeatherForecast, 3600000);
    // Инициализация попапа погоды
    initWeatherPopup();
    // Динамическая синхронизация: 2 сек в календаре, 10 сек в остальных экранах
    function scheduleNextSync() {
      var delay = (S.screen === 'calendar') ? 5000 : 15000;
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
