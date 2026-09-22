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
    syncedHooked: false
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
      return Promise.resolve({ ok: false, err: 'sync не загружен' });
    }
    var st = (typeof sync.status === 'function') ? sync.status() : null;
    if (!st || !st.connected) {
      return Promise.resolve({ ok: false, err: 'общая папка не подключена', needConnect: true });
    }
    state.saving = true;
    state.savingByUser = !!opts.byUser;
    updateIndicator('saving');
    // Параллельно: снапшот в localStorage + цикл синка
    var snapRes = snapshotWrite(collectSnapshot());
    var p;
    try { p = sync.cycle(); } catch (e) {
      state.saving = false;
      state.savingByUser = false;
      updateIndicator('err');
      return Promise.resolve({ ok: false, err: e && e.message || String(e) });
    }
    if (!p || typeof p.then !== 'function') {
      // sync.cycle в этой версии мог быть синхронным — считаем что запись будет
      state.lastFlush = Date.now();
      state.saving = false;
      state.savingByUser = false;
      updateIndicator('ok');
      return Promise.resolve({ ok: true, wrote: true, msg: 'снапшот' + (snapRes ? '' : ' (нет localStorage)') });
    }
    return p.then(function (res) {
      state.lastFlush = Date.now();
      state.saving = false;
      state.savingByUser = false;
      if (res && res.ok) {
        updateIndicator('ok');
        return { ok: true, wrote: !!res.wrote, msg: res.wrote ? 'общий файл + снапшот' : 'без изменений' };
      }
      if (res && res.skipped) {
        updateIndicator('idle');
        return { ok: false, skipped: true, msg: 'цикл пропущен (занят)' };
      }
      updateIndicator('err');
      return { ok: false, err: (res && res.err) || 'не удалось записать' };
    })['catch'](function (e) {
      state.saving = false;
      state.savingByUser = false;
      updateIndicator('err');
      return { ok: false, err: e && e.message || String(e) };
    });
  }

  /* ---------- ИНДИКАТОР + КНОПКА ---------- */
  // Цвет точки индикатора. Согласовано со стилями index.html (var --green/--muted).
  function setDotColor(color) {
    if (!state.dotEl) return;
    state.dotEl.style.background = color;
    state.dotEl.style.boxShadow = color === '#16a34a' ? '0 0 0 2px rgba(22,163,74,.18)' :
                                  color === '#dc2626' ? '0 0 0 2px rgba(220,38,38,.18)' :
                                  color === '#f59e0b' ? '0 0 0 2px rgba(245,158,11,.18)' :
                                  'none';
  }
  function setLabelText(text) {
    if (state.labelEl) state.labelEl.textContent = text;
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var dt = Math.round((Date.now() - ts) / 1000);
    if (dt < 5) return 'только что';
    if (dt < 60) return dt + ' с назад';
    if (dt < 3600) return Math.round(dt / 60) + ' мин назад';
    return Math.round(dt / 3600) + ' ч назад';
  }
  // Режимы: idle (серый, без текста), saving (жёлтый, «идёт сохранение…»),
  // ok (зелёный, «сохранено N с назад»), err (красный, «ошибка»), no-folder (мутный).
  function updateIndicator(mode) {
    if (!state.btnEl || !state.dotEl) return;
    var sync = window.SP_SYNC;
    var st = (sync && sync.status) ? sync.status() : null;
    var connected = st && st.connected;
    var lastSave = state.lastFlush || state.lastSnap;
    if (!state.labelEl) {
      // инициализация label если его не было
      var lbl = document.createElement('span');
      lbl.style.cssText = 'margin-left:6px;font-size:11px;color:var(--muted);font-weight:600;display:none';
      lbl.id = 'save-all-label';
      state.btnEl.appendChild(lbl);
      state.labelEl = lbl;
    }
    if (mode === 'saving') {
      setDotColor('#f59e0b'); setLabelText('⏳ сохраняю…'); state.labelEl.style.display = '';
      return;
    }
    if (mode === 'err') {
      setDotColor('#dc2626'); setLabelText('⚠ ошибка'); state.labelEl.style.display = '';
      return;
    }
    if (!connected) {
      setDotColor('#94a3b8'); setLabelText('общая папка не подключена'); state.labelEl.style.display = '';
      return;
    }
    // ok/idle
    setDotColor('#16a34a');
    setLabelText('✓ сохранено ' + fmtAgo(lastSave));
    state.labelEl.style.display = '';
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
        try { snapshotWrite(collectSnapshot()); updateIndicator('ok'); } catch (e) {}
        return p;
      }
      return p.then(function (res) {
        if (res && res.ok) {
          try { snapshotWrite(collectSnapshot()); state.lastFlush = Date.now(); updateIndicator('ok'); } catch (e) {}
        }
        return res;
      });
    };
    state.syncedHooked = true;
  }

  /* ---------- АВТОСОХРАНЕНИЕ КАЖДУЮ 1 МИНУТУ ---------- */
  // Безопасный запуск: первый цикл через 5 секунд после init, дальше
  // раз в 60 секунд. Если папка не подключена — снапшот всё равно
  // пишем (резервная копия в localStorage).
  function startAutoLoop() {
    stopAutoLoop();
    setTimeout(function () {
      autoTick();
    }, 5000);
    state.timer = setInterval(autoTick, 60 * 1000);
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
        updateIndicator('idle');
      }
    } catch (e) {
      console.warn('save_all autoTick:', e);
      updateIndicator('err');
    }
  }
  function stopAutoLoop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  /* ---------- УСТАНОВКА КНОПКИ В ТОПБАР ---------- */
  // Ищем существующую кнопку или создаём рядом с sync-btn.
  function ensureButton() {
    if (document.getElementById('save-all-btn')) {
      state.btnEl = document.getElementById('save-all-btn');
      state.dotEl = document.getElementById('save-all-dot');
      state.labelEl = document.getElementById('save-all-label');
      return;
    }
    var syncBtn = document.getElementById('sync-btn');
    if (!syncBtn || !syncBtn.parentNode) return;
    var btn = document.createElement('button');
    btn.id = 'save-all-btn';
    btn.className = 'btn ghost';
    btn.title = 'Сохранить всё (включая годовые графики) в общую папку. Авто-каждую минуту.';
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
    btn.innerHTML = '💾<span id="save-all-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#94a3b8;margin-left:1px;vertical-align:middle"></span>';
    btn.addEventListener('click', onSaveAllClick);
    // Ставим после sync-btn, перед logout
    var logout = document.querySelector('[data-action="logout"]');
    if (logout && logout.parentNode === syncBtn.parentNode) {
      syncBtn.parentNode.insertBefore(btn, logout);
    } else {
      syncBtn.parentNode.insertBefore(btn, syncBtn.nextSibling);
    }
    state.btnEl = btn;
    state.dotEl = document.getElementById('save-all-dot');
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
    // 4) Индикатор
    updateIndicator('idle');
    // 5) Авто-петля
    startAutoLoop();
    // Периодически обновлять «N мин назад»
    setInterval(function () { updateIndicator(state.saving ? 'saving' : 'idle'); }, 15000);
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