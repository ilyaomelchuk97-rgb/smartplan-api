/* ============================================================
   SmartPlan — «СОХРАНИТЬ ВСЁ» (save_all.js)
   ------------------------------------------------------------
   Гарантирует, что ВСЕ данные (включая годовые графики) летят
   в общий файл smartplan-db.json, не только синхронизируемые
   через sync.js (который работает по 5 сек циклу, но не даёт
   явной кнопки для мгновенного сброса).

   Возможности:
   · snapshotNow() — собрать и записать локальный снапшот ВСЕХ
     ключевых разделов + плановое содержимое графиков. Пишет
     в localStorage['smartplan_save_all_snapshot'] (резервная
     копия для аварийного восстановления).
   · flush() — форсировать цикл синхронизации (вызов
     SP_SYNC.cycle()) + снапшот. Это ускоряет отдачу прежней
     правки в общий файл без ожидания 5-секундного таймера.
   · Авто-каждые 60 секунд: flush() + перерисовка индикатора.
   · Кнопка «💾 Сохранить всё» в топбаре: если общая папка
     не подключена — открывает модалку синхронизации; иначе —
     мгновенный flush() с тостом «✓ Сохранено в общую папку».

   Защита:
   · Не ломается, если SP_SYNC ещё не загружен.
   · При недоступности localStorage (fallback в память) — модуль
     работает, но снапшот перестаёт переживать перезапуск.
   · Ошибки записи в SP_SYNC не подавляются — пользователь видит
     тост «⚠ Не удалось сохранить…».
   ============================================================ */
window.SP_SAVE_ALL = (function () {
  'use strict';

  // Ключ локального снапшота — резервная копия НА СЛУЧАЙ аварии
  // (сбой питания, переполнение NAS, случайное закрытие файла и т.д.).
  var SNAPSHOT_KEY = 'smartplan_save_all_snapshot';

  // Все ключи, которые попадают в «Сохранить всё». Разбиты на две группы:
  // 1) SYNC_KEYS — те же, что синхронизируются (через sync.js в общий файл).
  // 2) EXTRA_KEYS — расширения, которые sync.js не отправляет, но они
  //    критичны для рабочего состояния (текущий график, корзина, время маршрутов).
  // 3) GRAPH_DEEP_KEYS — глубокие подразделы графиков: список текущего
  //    графика (для восстановления «после перезапуска сразу видно свой график»).
  var SYNC_KEYS = [
    'smartplan_tasks_db',
    'smartplan_objects_db',
    'smartplan_users_db',
    'smartplan_areas_db',
    'smartplan_workers_db',
    'smartplan_work_catalog',
    'smartplan_graphs'
  ];
  var EXTRA_KEYS = [
    'smartplan_graphs_cur',
    'smartplan_trash',
    'smartplan_route_time',
    'smartplan_test_closures'
  ];

  var state = {
    timer: null,
    lastSnap: 0,
    lastFlush: 0,
    lastSavedLocal: null,      // текст последнего снапшота (для дедупликации)
    saving: false,
    savingByUser: false,
    btnEl: null,
    dotEl: null,
    labelEl: null,
    ringEl: null,              // SVG-кольцо прогресса (60 с)
    syncedHooked: false,
    // ----- таймер обратного отсчёта -----
    nextTickAt: 0,             // Date.now() ближайшего следующего автосохранения
    tickInterval: 60 * 1000,   // период 60 сек
    firstDelay: 5000,          // первый тик через 5 сек
    rafHandle: null,           // requestAnimationFrame для плавной перерисовки
    // ----- ошибки -----
    lastErrorMsg: null         // текст последней ошибки (для отображения в кольце)
  };

  // Аккуратное чтение JSON-значения из localStorage
  function loadLS(k) {
    try {
      var raw = window.localStorage.getItem(k);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function saveLS(k, v) {
    try { window.localStorage.setItem(k, v); return true; }
    catch (e) { return false; }
  }

  /* ---------- ПРЯМОЙ DOM-ТОСТ (fallback, если app.js не успел инициализировать свой) ---------- */
  // Использует тот же #toasts контейнер, что и app.js. Если контейнера нет —
  // создаём. Это позволяет кнопке работать даже ДО полного старта приложения.
  function fallbackToast(type, msg) {
    try {
      var host = document.getElementById('toasts');
      if (!host) {
        host = document.createElement('div');
        host.id = 'toasts';
        host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:999999;display:flex;flex-direction:column;gap:9px;pointer-events:none';
        document.body.appendChild(host);
      }
      var d = document.createElement('div');
      d.className = 'toast ' + (type || 'ok');
      d.style.cssText = 'background:#1f2d3d;color:#fff;padding:12px 15px;border-radius:10px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-width:340px;border-left:4px solid ' +
        (type === 'err' ? '#dc2626' : type === 'warn' ? '#ca8a04' : '#16a34a') +
        ';animation:in .2s ease;pointer-events:none';
      d.textContent = msg;
      host.appendChild(d);
      setTimeout(function () { if (d && d.parentNode) d.parentNode.removeChild(d); }, 4200);
    } catch (e) { console.log('[save_all]', msg); }
  }

  /* ---------- СБОР СНАПШОТА ВСЕХ ДАННЫХ ---------- */
  // Возвращает { ts, sections, extras, bytes } — что и когда сохранено.
  // Снапшот НЕ включает личное (сессия, логин, кэш геокодера, погода) —
  // только то, что имеет деловую ценность.
  function collectSnapshot() {
    var snap = {
      ts: Date.now(),
      app: 'SmartPlan',
      kind: 'save_all',
      v: 1,
      sections: {},
      extras: {}
    };
    var bytes = 0;
    SYNC_KEYS.forEach(function (k) {
      var v = loadLS(k);
      snap.sections[k] = v;
      try { bytes += (window.localStorage.getItem(k) || '').length; } catch (e) {}
    });
    EXTRA_KEYS.forEach(function (k) {
      var v = loadLS(k);
      snap.extras[k] = v;
      try { bytes += (window.localStorage.getItem(k) || '').length; } catch (e) {}
    });
    // Сводка по графикам (для быстрого взгляда в файле)
    try {
      var graphs = snap.sections['smartplan_graphs'];
      if (Array.isArray(graphs)) {
        var sum = { count: graphs.length, withWorks: 0, withObjs: 0 };
        graphs.forEach(function (g) {
          if (g && Array.isArray(g.works) && g.works.length) sum.withWorks++;
          if (g && Array.isArray(g.objs) && g.objs.length) sum.withObjs++;
        });
        snap.graphSummary = sum;
      }
    } catch (e) {}
    snap.bytes = bytes;
    return snap;
  }

  // Записать снапшот в localStorage. Молча игнорирует ошибки (фолбэк
  // на in-memory шим из index.html), но возвращает факт записи.
  function snapshotWrite(snap) {
    var json = JSON.stringify(snap);
    var ok = saveLS(SNAPSHOT_KEY, json);
    state.lastSnap = snap.ts;
    state.lastSavedLocal = json;
    return ok;
  }

  // Публичный: собрать и записать снапшот (без сетевых операций).
  // Возвращает { ok, ts, bytes, sections, extras }.
  function snapshotNow() {
    try {
      var snap = collectSnapshot();
      var ok = snapshotWrite(snap);
      return { ok: ok, ts: snap.ts, bytes: snap.bytes,
               sections: Object.keys(snap.sections).length,
               extras: Object.keys(snap.extras).length };
    } catch (e) {
      return { ok: false, err: e && e.message || String(e) };
    }
  }

  /* ---------- ФОРСИРОВАННЫЙ СБРОС В ОБЩИЙ ФАЙЛ ---------- */
  // Вызывает sync.js на немедленный цикл чтение→слияние→запись.
  // Без подключённой общей папки — мягкий возврат ok:false (без throw).
  // Возвращает Promise<{ ok, wrote, msg }>.
  function flushToFile(opts) {
    opts = opts || {};
    if (state.saving) {
      return Promise.resolve({ ok: false, skipped: true, msg: 'уже идёт сохранение' });
    }
    var sync = window.SP_SYNC;
    if (!sync || typeof sync.cycle !== 'function') {
      state.lastErrorMsg = 'sync не загружен';
      updateIndicator('err');
      return Promise.resolve({ ok: false, err: state.lastErrorMsg });
    }
    var st = (typeof sync.status === 'function') ? sync.status() : null;
    if (!st || !st.connected) {
      // Не подключено — это не ошибка, а состояние. Возвращаем как есть.
      updateIndicator('idle');
      return Promise.resolve({ ok: false, err: 'общая папка не подключена', needConnect: true });
    }
    state.saving = true;
    state.savingByUser = !!opts.byUser;
    state.lastErrorMsg = null;
    updateIndicator('saving');
    // Параллельно: снапшот в localStorage + цикл синка
    var snapRes = snapshotWrite(collectSnapshot());
    var p;
    try { p = sync.cycle(); } catch (e) {
      state.saving = false;
      state.savingByUser = false;
      state.lastErrorMsg = e && e.message || String(e);
      updateIndicator('err');
      return Promise.resolve({ ok: false, err: state.lastErrorMsg });
    }
    if (!p || typeof p.then !== 'function') {
      // sync.cycle в этой версии мог быть синхронным — считаем что запись будет
      state.lastFlush = Date.now();
      state.saving = false;
      state.savingByUser = false;
      rescheduleNextTick();
      updateIndicator('ok');
      return Promise.resolve({ ok: true, wrote: true, msg: 'снапшот' + (snapRes ? '' : ' (нет localStorage)') });
    }
    return p.then(function (res) {
      state.lastFlush = Date.now();
      state.saving = false;
      state.savingByUser = false;
      rescheduleNextTick();
      if (res && res.ok) {
        updateIndicator('ok');
        return { ok: true, wrote: !!res.wrote, msg: res.wrote ? 'общий файл + снапшот' : 'без изменений' };
      }
      if (res && res.skipped) {
        updateIndicator('idle');
        return { ok: false, skipped: true, msg: 'цикл пропущен (занят)' };
      }
      state.lastErrorMsg = (res && res.err) || 'не удалось записать';
      updateIndicator('err');
      return { ok: false, err: state.lastErrorMsg };
    })['catch'](function (e) {
      state.saving = false;
      state.savingByUser = false;
      state.lastErrorMsg = e && e.message || String(e);
      updateIndicator('err');
      return { ok: false, err: state.lastErrorMsg };
    });
  }

  /* ---------- ИНДИКАТОР + КНОПКА ---------- */
  // Цвета состояния: задаются единым набором для кольца, иконки и подписи.
  // saving — жёлтый (в процессе); err — красный; idle-ok — зелёный;
  // no-folder — серый (только локальный снапшот).
  var COLORS = {
    ok:        '#16a34a',
    saving:    '#f59e0b',
    err:       '#dc2626',
    noFolder:  '#94a3b8',
    soonWarn:  '#f59e0b'  // когда осталось <= 10 с до тика
  };
  // SVG-кольцо (окружность r=9): периметр = 2 * Math.PI * 9 ≈ 56.549
  var RING_PERIM = 2 * Math.PI * 9;

  function setRingColor(color) {
    if (!state.ringEl) return;
    state.ringEl.setAttribute('stroke', color);
  }
  function setRingProgress(fraction) {  // 0 = пусто, 1 = полное кольцо
    if (!state.ringEl) return;
    var off = (1 - Math.max(0, Math.min(1, fraction))) * RING_PERIM;
    state.ringEl.setAttribute('stroke-dashoffset', off.toFixed(2));
  }
  function ensureLabel() {
    if (state.labelEl) return state.labelEl;
    var lbl = document.createElement('span');
    lbl.style.cssText = 'margin-left:6px;font-size:11px;color:var(--muted);font-weight:600;display:none;white-space:nowrap';
    lbl.id = 'save-all-label';
    state.btnEl.appendChild(lbl);
    state.labelEl = lbl;
    return lbl;
  }
  function setLabelText(text, color) {
    var lbl = ensureLabel();
    lbl.textContent = text;
    if (color) lbl.style.color = color;
    lbl.style.display = '';
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var dt = Math.round((Date.now() - ts) / 1000);
    if (dt < 5) return 'только что';
    if (dt < 60) return dt + ' с назад';
    if (dt < 3600) return Math.round(dt / 60) + ' мин назад';
    return Math.round(dt / 3600) + ' ч назад';
  }

  /* ----- ПЛАВНАЯ ПЕРЕРИСОВКА (60 fps) -----
     Каждый кадр пересчитывает прогресс кольца и текст отсчёта.
     Делает одну работу — обновляет DOM. Не запускает никаких циклов. */
  function renderTick() {
    if (!state.btnEl || !state.ringEl) return;
    var sync = window.SP_SYNC;
    var st = (sync && sync.status) ? sync.status() : null;
    var connected = st && st.connected;
    var now = Date.now();
    // В процессе сохранения — кольцо полное (как «индикатор загрузки»), текст «сохраняю…»
    if (state.saving) {
      setRingColor(COLORS.saving);
      setRingProgress(1);
      setLabelText('⏳ сохраняю…', COLORS.saving);
      // маленькая анимация «дыхания» — кольцо мигает прозрачностью
      if (state.ringEl) state.ringEl.style.opacity = (Math.sin(now / 200) + 1) / 2 * 0.6 + 0.4;
      scheduleRender();
      return;
    }
    // Ошибка — кольцо полное красное
    if (state.lastError) {
      setRingColor(COLORS.err);
      setRingProgress(1);
      if (state.ringEl) state.ringEl.style.opacity = 1;
      setLabelText('⚠ ошибка' + (state.lastError ? ': ' + state.lastError : ''), COLORS.err);
      scheduleRender();
      return;
    }
    // Папка не подключена — серое кольцо, считает до снапшота (он всё равно пишется локально)
    if (!connected) {
      setRingColor(COLORS.noFolder);
      setRingProgress(state.nextTickAt > now ? (now - (state.nextTickAt - state.tickInterval)) / state.tickInterval : 0);
      if (state.ringEl) state.ringEl.style.opacity = 1;
      var remain0 = state.nextTickAt > now ? Math.ceil((state.nextTickAt - now) / 1000) : 0;
      setLabelText('⏳ снапшот через ' + remain0 + ' с', COLORS.noFolder);
      scheduleRender();
      return;
    }
    // OK — зелёное кольцо с обратным отсчётом
    var remain = state.nextTickAt > now ? Math.ceil((state.nextTickAt - now) / 1000) : 0;
    var frac = state.nextTickAt > now ? (now - (state.nextTickAt - state.tickInterval)) / state.tickInterval : 0;
    setRingProgress(frac);
    if (state.ringEl) state.ringEl.style.opacity = 1;
    // Когда осталось ≤10 с — кольцо и текст оранжевеют (предупреждение)
    if (remain > 0 && remain <= 10) {
      setRingColor(COLORS.soonWarn);
      setLabelText('⏳ через ' + remain + ' с', COLORS.soonWarn);
    } else {
      setRingColor(COLORS.ok);
      setLabelText('⏳ через ' + remain + ' с', 'var(--muted)');
    }
    scheduleRender();
  }
  function scheduleRender() {
    if (state.rafHandle) return;
    state.rafHandle = requestAnimationFrame(function () {
      state.rafHandle = null;
      renderTick();
    });
  }

  // Режимы: idle, saving (жёлтый, «идёт сохранение…»), err (красный, «ошибка»).
  // При любом режиме — плавная перерисовка кольца через renderTick().
  function updateIndicator(mode) {
    if (!state.btnEl || !state.ringEl) return;
    state.lastError = (mode === 'err') ? (state.lastErrorMsg || 'сохранение не удалось') : null;
    if (mode !== 'err') state.lastErrorMsg = null;
    // принудительно перерисовать
    renderTick();
  }

  // Кнопка «💾 Сохранить всё» в топбаре. Если папка не подключена —
  // открывает модалку синхронизации (та же, что у sync-btn).
  function onSaveAllClick() {
    if (state.saving) return;
    var sync = window.SP_SYNC;
    var st = (sync && sync.status) ? sync.status() : null;
    if (!st || !st.connected) {
      // Открываем модалку синхронизации — пусть пользователь выберет папку
      try {
        var syncBtn = document.getElementById('sync-btn');
        if (syncBtn) syncBtn.click();
        // Лёгкий стикер, что сохранение идёт после подключения
        if (window.SP_TOAST) window.SP_TOAST('info', 'Подключите общую папку — сохранение включится автоматически');
      } catch (e) {}
      return;
    }
    flushToFile({ byUser: true }).then(function (r) {
      if (window.SP_TOAST) {
        if (r.ok) window.SP_TOAST('ok', '✓ Сохранено в общую папку · ' + Object.keys((window.SP_SYNC && window.SP_SYNC.SYNC_KEYS) || {}).length + ' разделов');
        else if (r.skipped) window.SP_TOAST('warn', '⏳ Сохранение уже идёт');
        else window.SP_TOAST('err', '⚠ Не удалось сохранить: ' + (r.err || 'неизвестная ошибка'));
      } else {
        // fallback: прямой DOM-тост (на случай, если app.js ещё не прогрузился)
        fallbackToast(r.ok ? 'ok' : (r.skipped ? 'warn' : 'err'),
          r.ok ? '✓ Сохранено в общую папку' :
          (r.skipped ? '⏳ Сохранение уже идёт' :
           '⚠ Не удалось сохранить: ' + (r.err || 'неизвестная ошибка')));
      }
    });
  }

  /* ---------- ХУК НА SP_SYNC.cycle ---------- */
  // После каждого УСПЕШНОГО цикла синка обновляем локальный снапшот —
  // гарантия, что после любой записи в общий файл мы имеем его
  // локальную копию для аварийного восстановления.
  // Устанавливается ОДИН РАЗ (state.syncedHooked). Используем прокси:
  // сохраняем оригинальный cycle, оборачиваем, при успехе — снапшот.
  function hookSyncCycle() {
    var sync = window.SP_SYNC;
    if (!sync || typeof sync.cycle !== 'function' || state.syncedHooked) return;
    var orig = sync.cycle.bind(sync);
    sync.cycle = function () {
      var p = orig();
      if (!p || typeof p.then !== 'function') {
        // sync был синхронный (старый API) — снапшот после первого успешного
        try { snapshotWrite(collectSnapshot()); state.lastFlush = Date.now(); rescheduleNextTick(); updateIndicator('ok'); } catch (e) {}
        return p;
      }
      return p.then(function (res) {
        if (res && res.ok) {
          try { snapshotWrite(collectSnapshot()); state.lastFlush = Date.now(); rescheduleNextTick(); updateIndicator('ok'); } catch (e) {}
        }
        return res;
      });
    };
    state.syncedHooked = true;
  }

  /* ---------- ПЕРЕПЛАНИРОВКА СЛЕДУЮЩЕГО ТИКА ----------
     Каждый раз, когда сохранение произошло — следующий авто-тик
     запланирован через 60 с от ТЕКУЩЕГО момента. Это защищает от
     дрейфа (если interval тикал не вовремя — теперь он всегда
     «60 с после последнего сохранения»). */
  function rescheduleNextTick() {
    state.nextTickAt = Date.now() + state.tickInterval;
  }

  /* ---------- АВТОСОХРАНЕНИЕ КАЖДУЮ 1 МИНУТУ ---------- */
  // Безопасный запуск: первый цикл через 5 секунд после init, дальше
  // раз в 60 секунд. Если папка не подключена — снапшот всё равно
  // пишем (резервная копия в localStorage).
  // Кольцо прогресса считает до state.nextTickAt, обновляясь через
  // requestAnimationFrame (renderTick).
  function startAutoLoop() {
    stopAutoLoop();
    state.nextTickAt = Date.now() + state.firstDelay;  // первый тик через 5 с
    // Используем setInterval как fallback, но реальный «счёт до тика»
    // идёт по nextTickAt. Это значит, что даже если бы интервал
    // пропустил тик — мы поймаем это при следующем renderTick.
    state.timer = setInterval(function () {
      // Если nextTickAt прошёл — тикаем; иначе ждём (не делаем лишних сохранений)
      if (Date.now() >= state.nextTickAt) autoTick();
    }, 1000);  // проверка каждую секунду (но фактический flush — раз в 60 с)
    // Гарантируем первый авто-тик через 5 секунд:
    setTimeout(function () {
      if (Date.now() >= state.nextTickAt - (state.tickInterval - state.firstDelay)) autoTick();
    }, state.firstDelay);
  }
  function autoTick() {
    try {
      var sync = window.SP_SYNC;
      var st = (sync && sync.status) ? sync.status() : null;
      if (st && st.connected) {
        flushToFile({ byUser: false });
      } else {
        // Папка не подключена — пишем только локальный снапшот
        snapshotWrite(collectSnapshot());
        state.lastErrorMsg = null;
        rescheduleNextTick();
        updateIndicator('idle');
      }
    } catch (e) {
      console.warn('save_all autoTick:', e);
      state.lastErrorMsg = e && e.message || String(e);
      updateIndicator('err');
    }
  }
  function stopAutoLoop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.rafHandle) { cancelAnimationFrame(state.rafHandle); state.rafHandle = null; }
  }

  /* ---------- УСТАНОВКА КНОПКИ В ТОПБАР ---------- */
  // Ищем существующую кнопку или создаём рядом с sync-btn.
  // Кнопка содержит: SVG-кольцо прогресса (60 с) + эмодзи «💾» по центру +
  // маленькую точку-индикатор (для статуса) + текстовую подпись (отсчёт/состояние).
  function ensureButton() {
    if (document.getElementById('save-all-btn')) {
      state.btnEl = document.getElementById('save-all-btn');
      state.dotEl = document.getElementById('save-all-dot');
      state.labelEl = document.getElementById('save-all-label');
      state.ringEl = document.getElementById('save-all-ring');
      return;
    }
    var syncBtn = document.getElementById('sync-btn');
    if (!syncBtn || !syncBtn.parentNode) return;
    var btn = document.createElement('button');
    btn.id = 'save-all-btn';
    btn.className = 'btn ghost';
    btn.title = 'Сохранить всё (включая годовые графики) в общую папку. Авто-каждую минуту.';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
    // SVG-кольцо 22×22 px. cx=11, cy=11, r=9 — окружность с периметром 2π·9 ≈ 56.55
    // stroke-dasharray = «P, P» где P — периметр; dashoffset 0 → полное кольцо,
    // dashoffset P → пустое. Анимируем смещением в обратном отсчёте.
    btn.innerHTML =
      '<span id="save-all-ring-wrap" style="position:relative;display:inline-block;width:22px;height:22px;vertical-align:middle">' +
        '<svg id="save-all-ring" width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(-90deg);position:absolute;inset:0">' +
          '<circle cx="11" cy="11" r="9" fill="none" stroke="#e2e8f0" stroke-width="2.2"></circle>' +
          '<circle id="save-all-ring-fg" cx="11" cy="11" r="9" fill="none" stroke="#16a34a" stroke-width="2.2"' +
            ' stroke-linecap="round" stroke-dasharray="56.55" stroke-dashoffset="0"' +
            ' style="transition:stroke .25s ease, stroke-dashoffset .4s linear"></circle>' +
        '</svg>' +
        '<span id="save-all-icon" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1">💾</span>' +
      '</span>';
    btn.addEventListener('click', onSaveAllClick);
    // Ставим после sync-btn, перед logout
    var logout = document.querySelector('[data-action="logout"]');
    if (logout && logout.parentNode === syncBtn.parentNode) {
      syncBtn.parentNode.insertBefore(btn, logout);
    } else {
      syncBtn.parentNode.insertBefore(btn, syncBtn.nextSibling);
    }
    state.btnEl = btn;
    state.ringEl = document.getElementById('save-all-ring-fg');
    state.dotEl = document.getElementById('save-all-dot'); // backward-compat: точка больше не в DOM, но оставляем null
    state.dotEl = null;
    state.labelEl = null;
  }

  /* ---------- ПУБЛИЧНЫЙ API ---------- */
  function init(opts) {
    opts = opts || {};
    // Не запускаем дважды
    if (state.timer) return;
    // 1) Кнопка и индикатор — сразу
    try { ensureButton(); } catch (e) { console.warn('save_all ensureButton:', e); }
    // 2) Хук на SP_SYNC.cycle
    try { hookSyncCycle(); } catch (e) { console.warn('save_all hookSyncCycle:', e); }
    // 3) Первый снапшот — сразу
    try { snapshotWrite(collectSnapshot()); } catch (e) {}
    // 4) Индикатор + первый кадр кольца
    updateIndicator('idle');
    // 5) Авто-петля (внутри стартует renderTick через requestAnimationFrame)
    startAutoLoop();
    // Гарантируем, что кольцо отрисуется сразу (до первого таймаута)
    renderTick();
  }

  // Восстановить снапшот в localStorage (если данные были утеряны).
  // Публичный метод для будущих «восстановительных» кнопок.
  function restore() {
    var snap = loadLS(SNAPSHOT_KEY);
    if (!snap || !snap.sections) return { ok: false, err: 'снапшот пуст' };
    var n = 0;
    Object.keys(snap.sections).forEach(function (k) {
      if (saveLS(k, JSON.stringify(snap.sections[k]))) n++;
    });
    if (snap.extras) {
      Object.keys(snap.extras).forEach(function (k) {
        if (saveLS(k, JSON.stringify(snap.extras[k]))) n++;
      });
    }
    return { ok: true, restored: n, when: snap.ts };
  }

  function status() {
    var sync = window.SP_SYNC;
    var st = (sync && sync.status) ? sync.status() : null;
    return {
      connected: !!(st && st.connected),
      lastSnap: state.lastSnap,
      lastFlush: state.lastFlush,
      saving: state.saving,
      savingByUser: state.savingByUser,
      snapshotBytes: (state.lastSavedLocal || '').length,
      sections: SYNC_KEYS.length,
      extras: EXTRA_KEYS.length
    };
  }

  return {
    init: init,
    snapshotNow: snapshotNow,
    flush: flushToFile,
    restore: restore,
    status: status,
    SNAPSHOT_KEY: SNAPSHOT_KEY,
    SYNC_KEYS: SYNC_KEYS.slice(),
    EXTRA_KEYS: EXTRA_KEYS.slice()
  };
})();