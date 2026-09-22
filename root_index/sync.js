/* ============================================================
   SmartPlan — СИНХРОНИЗАЦИЯ ЧЕРЕЗ ОБЩУЮ ПАПКУ (sync.js)
   Несколько человек работают в сайте одновременно БЕЗ СЕРВЕРА:
   база хранится в файле smartplan-db.json в общей сетевой папке,
   каждые 5 секунд каждый браузер читает файл, объединяет изменения
   (по ревизиям — чья правка новее, та и побеждает) и записывает назад.

   Как это работает:
   1. «Подключить общую папку» → showDirectoryPicker (Edge/Chrome).
      Доступ к папке браузер запоминает (IndexedDB) — при следующих
      запусках может попросить «Разрешить» один раз за сессию.
   2. Синхронизируемые разделы: задачи, объекты, пользователи, участки,
      работники, виды работ, графики. Личные настройки не синхронизируются.
   3. Конфликты: правка с более новой ревизией побеждает; удаления
      передаются «надгробиями» (tombstone) — удалённое не воскреснет.
   4. Файл пишется атомарно (createWritable) — читатели не видят
      недописанных состояний.
   ============================================================ */
window.SP_SYNC = (function () {
  'use strict';

  var FILE_NAME = 'smartplan-db.json';
  var INTERVAL = 5000;               // цикл синхронизации, мс
  var IDB_NAME = 'smartplan-sync';   // хранилище ссылки на папку
  var IDB_STORE = 'h';
  var SHADOW_KEY = 'smartplan_sync_shadow'; // что мы отправляли/получали в прошлый цикл
  var TOMB_KEY = 'smartplan_sync_tomb';     // «надгробия» удалённых записей
  var TOMB_TTL = 30 * 24 * 3600 * 1000;     // удаления помним 30 дней

  /* какие ключи localStorage синхронизируются и как из них достать записи */
  var SYNC_KEYS = {
    smartplan_tasks_db:     { kind: 'coll', field: 'tasks',   label: 'задачи' },
    smartplan_objects_db:   { kind: 'coll', field: 'objects', label: 'объекты' },
    smartplan_users_db:     { kind: 'coll', field: 'users',   label: 'пользователи' },
    smartplan_areas_db:     { kind: 'coll', field: 'areas',   label: 'участки' },
    smartplan_workers_db:   { kind: 'map',  field: 'workers', label: 'работники' },
    smartplan_work_catalog: { kind: 'map',  field: 'areas',   label: 'виды работ' },
    smartplan_graphs:       { kind: 'root',                  label: 'графики' }
  };

  var state = {
    dir: null,            // FileSystemDirectoryHandle общей папки
    file: null,           // FileSystemFileHandle файла базы
    transport: null,      // {read, write} — реальный файл или подмена для тестов
    timer: null,
    status: 'off',        // off | perm | ok | err
    err: '',
    last: 0,
    busy: false,
    onChange: null
  };

  function loadLS(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- записи раздела ---------- */
  function sectionRecords(key, db) {
    var cfg = SYNC_KEYS[key];
    var m = {};
    try {
      if (cfg.kind === 'root') {
        (db || []).forEach(function (r) { if (r && r.id != null) m[r.id] = r; });
        return m;
      }
      if (!db) return {};
      var coll = db[cfg.field];
      if (!coll) return {};
      if (cfg.kind === 'map') Object.keys(coll).forEach(function (id) { m[id] = coll[id]; });
      else (coll || []).forEach(function (r) { if (r && r.id != null) m[r.id] = r; });
    } catch (e) {}
    return m;
  }
  function rebuildSection(key, records, oldDb) {
    var cfg = SYNC_KEYS[key];
    if (cfg.kind === 'root') {
      var arr = [];
      Object.keys(records).forEach(function (id) { arr.push(records[id]); });
      return arr;
    }
    var db = {};
    if (oldDb && oldDb.schema != null) db.schema = oldDb.schema;
    if (cfg.kind === 'map') db[cfg.field] = records;
    else {
      var a = [];
      Object.keys(records).forEach(function (id) { a.push(records[id]); });
      db[cfg.field] = a;
    }
    return db;
  }

  /* ---------- ГЛАВНОЕ: один цикл слияния ----------
     fileData — содержимое общего файла (или null, если файла ещё нет).
     Возвращает { sections, counts }: counts — что применили к себе
     от других (для тоста и обновления экранов). */
  function mergeCycle(fileData) {
    var shadow = loadLS(SHADOW_KEY) || {};
    var tomb = loadLS(TOMB_KEY) || {};
    var now = Date.now();
    var fsecs = (fileData && fileData.sections) || null;
    var out = { sections: {} };
    var counts = {};

    Object.keys(SYNC_KEYS).forEach(function (key) {
      var localDb = loadLS(key);
      var recs = sectionRecords(key, localDb);
      var sh = shadow[key] = shadow[key] || { j: {}, r: {} };
      var tb = tomb[key] = tomb[key] || {};
      var fsec = fsecs ? (fsecs[key] || null) : null;
      var frecs = (fsec && fsec.records) || {};
      var frev = (fsec && fsec.rev) || {};
      var ftomb = (fsec && fsec.tomb) || {};

      // все встречавшиеся id
      var ids = {};
      Object.keys(recs).forEach(function (id) { ids[id] = 1; });
      Object.keys(frecs).forEach(function (id) { ids[id] = 1; });
      Object.keys(sh.j).forEach(function (id) { ids[id] = 1; });

      // 1) локальные ревизии: не изменилась с прошлого цикла — прежняя,
      //    изменилась — сейчас (для задач — их собственный updated_at)
      var lrev = {};
      Object.keys(recs).forEach(function (id) {
        var j = JSON.stringify(recs[id]);
        if (sh.j[id] === j) { lrev[id] = sh.r[id] || 0; return; }
        lrev[id] = Math.max((recs[id] && recs[id].updated_at) || 0, (sh.r[id] || 0) + 1, now);
      });

      // 2) локальные удаления: была в тени, исчезла локально → надгробие
      Object.keys(sh.j).forEach(function (id) {
        if (!recs.hasOwnProperty(id)) tb[id] = Math.max(tb[id] || 0, now);
      });

      // 3) слияние по каждой записи
      var mRecs = {}, mRev = {}, mTomb = {};
      Object.keys(ids).forEach(function (id) {
        var hasL = recs.hasOwnProperty(id), hasF = frecs.hasOwnProperty(id);
        var lr = lrev[id] || 0, fr = frev[id] || 0;
        var tF = ftomb[id] || 0, tL = tb[id] || 0;
        var tmax = Math.max(tF, tL);
        if (!hasL && !hasF) { if (tmax > 0 && now - tmax < TOMB_TTL) mTomb[id] = tmax; return; }
        if (tmax > 0 && tmax >= Math.max(lr, fr)) { // удаление новее обеих версий
          mTomb[id] = tmax;
          if (tF > tL) tb[id] = tF; // чужое удаление запомнить и у себя
          return;
        }
        var pick, pickRev, fromFile;
        if (hasL && hasF) {
          if (fr > lr) { pick = frecs[id]; pickRev = fr; fromFile = true; }
          else { pick = recs[id]; pickRev = Math.max(lr, fr); fromFile = false; }
        } else if (hasL) { pick = recs[id]; pickRev = lr; fromFile = false; }
        else { pick = frecs[id]; pickRev = fr; fromFile = true; }
        mRecs[id] = pick; mRev[id] = pickRev;
        if (fromFile) {
          var pj = JSON.stringify(pick);
          if (!hasL || sh.j[id] !== pj) counts[key] = (counts[key] || 0) + 1; // применяем к себе чужое
        }
      });

      // 4) применить слияние к своему localStorage — если оно отличается от
      //    локального (чужие записи, чужие удаления)
      var needApply = false, dels = 0;
      Object.keys(recs).forEach(function (id) {
        if (!mRecs.hasOwnProperty(id)) { needApply = true; dels++; } // запись удалена другим
      });
      if (!needApply) {
        for (var mid in mRecs) {
          if (!recs.hasOwnProperty(mid) || JSON.stringify(recs[mid]) !== JSON.stringify(mRecs[mid])) { needApply = true; break; }
        }
      }
      if (needApply) {
        if (dels) counts[key] = (counts[key] || 0) + dels; // удаления тоже показать в тосте
        saveLS(key, rebuildSection(key, mRecs, localDb));
      }
      // 5) новая тень = слитое состояние
      sh.j = {}; sh.r = {};
      Object.keys(mRecs).forEach(function (id) { sh.j[id] = JSON.stringify(mRecs[id]); sh.r[id] = mRev[id]; });
      out.sections[key] = { records: mRecs, rev: mRev, tomb: mTomb };
    });

    saveLS(SHADOW_KEY, shadow);
    saveLS(TOMB_KEY, tomb);
    return { sections: out.sections, counts: counts };
  }

  /* ---------- транспорт: реальный файл в общей папке ---------- */
  async function readThrough() {
    var f = await state.file.getFile();
    var txt = await f.text();
    if (!txt) return null;
    return JSON.parse(txt);
  }
  async function writeThrough(data) {
    var w;
    try {
      w = await state.file.createWritable();
      await w.write(JSON.stringify(data));
      await w.close();
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || /perm|denied/i.test(e.message))) {
        state.status = 'perm';
        state.err = 'Нужно разрешить редактирование';
      }
      throw e;
    }
  }

  /* ---------- один цикл: прочитать → слить → записать ---------- */
  async function cycle() {
    if (state.busy || !state.transport) return { skipped: true };
    state.busy = true;
    try {
      var fileData = await state.transport.read();
      var res = mergeCycle(fileData);
      var core = JSON.stringify({ app: 'SmartPlan', v: 1, sections: res.sections });
      var same = false;
      if (fileData) {
        try { same = JSON.stringify({ app: fileData.app, v: fileData.v, sections: fileData.sections }) === core; } catch (e) {}
      }
      if (!same) await state.transport.write({ app: 'SmartPlan', v: 1, ts: Date.now(), sections: res.sections });
      state.status = 'ok'; state.err = ''; state.last = Date.now();
      if (res.counts && Object.keys(res.counts).length && state.onChange) {
        try { state.onChange(res.counts); } catch (e) { console.error('sync onChange:', e); }
      }
      state.busy = false;
      return { ok: true, counts: res.counts, wrote: !same };
    } catch (e) {
      state.status = 'err'; state.err = (e && e.message) || String(e);
      state.busy = false;
      return { ok: false, err: state.err };
    }
  }

  /* ---------- IndexedDB: запомнить выбранный файл/папку ---------- */
  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        var rq = indexedDB.open(IDB_NAME, 1);
        rq.onupgradeneeded = function () { try { rq.result.createObjectStore(IDB_STORE); } catch (e) {} };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error || new Error('IndexedDB недоступен')); };
      } catch (e) { rej(e); }
    });
  }
  async function idbPut(handle, key) {
    var db = await idbOpen();
    return new Promise(function (res, rej) {
      try {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error || new Error('idb put')); };
      } catch (e) { rej(e); }
    });
  }
  async function idbGet(key) {
    var db = await idbOpen();
    return new Promise(function (res) {
      try {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var rq = tx.objectStore(IDB_STORE).get(key);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  async function idbDel(key) {
    try {
      var db = await idbOpen();
      await new Promise(function (res) {
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(key);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
        } catch (e) { res(false); }
      });
    } catch (e) {}
  }

  /* ---------- подключение ---------- */
  function stopLoop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.transport = null;
  }
  async function startWithFileHandle(fh) {
    stopLoop();
    state.file = fh;
    state.transport = { read: readThrough, write: writeThrough };
    state.status = 'ok';
    state.timer = setInterval(function () { cycle(); }, INTERVAL);
    cycle();
    return true;
  }
  async function startFromDir(dir) {
    var fh;
    try { fh = await dir.getFileHandle(FILE_NAME, { create: true }); }
    catch (e) { state.status = 'err'; state.err = e.message; return false; }
    state.dir = dir;
    state.mode = 'dir';
    return await startWithFileHandle(fh);
  }
  /* Способ 1 (рекомендуется): ФАЙЛ базы через диалог «Сохранить» —
     работает даже там, где выбор ПАПКИ запрещён («содержит системные
     файлы» на сетевых шарах). Файл создаётся или открывается существующий. */
  async function connectFile() {
    if (!window.showOpenFilePicker) throw new Error('Браузер не поддерживает выбор файла (нужен Edge или Chrome)');
    var fhs = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'База SmartPlan (smartplan-db.json)', accept: { 'application/json': ['.json'] } }]
    });
    var fh = fhs && fhs[0];
    if (!fh) { state.status = 'err'; state.err = 'Файл не выбран'; return false; }
    // При открытии файла через showOpenFilePicker браузер обычно сам даёт права readwrite.
    // Не запрашиваем явно — первый цикл записи (writeThrough) сам покажет запрос,
    // если прав ещё нет.
    state.dir = null;
    state.mode = 'file';
    await idbPut(fh, 'file');
    await idbDel('dir');
    try {
      var ok = await startWithFileHandle(fh);
      if (ok) state.permChecked = true; // отметка: первая запись уже отработала
      return ok;
    } catch (e) {
      state.status = 'err';
      state.err = 'Не удалось записать: ' + (e && e.message ? e.message : String(e)) + '. Переподключите файл и разрешите редактирование.';
      return false;
    }
  }
  /* Способ 2: выбор ПАПКИ (может отказывать на сетевых шарах NAS) */
  async function connect() {
    if (!window.showDirectoryPicker) throw new Error('Браузер не поддерживает выбор папки (нужен Edge или Chrome)');
    var dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbPut(dir, 'dir');
    await idbDel('file');
    return await startFromDir(dir);
  }
  /* Способ 3: перетащить папку или файл базы из проводника */
  async function connectDrop(handle) {
    try {
      if (!handle) return false;
      var p = 'granted';
      try { p = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) {}
      if (p !== 'granted') {
        try { p = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) {}
        if (p !== 'granted') { state.status = 'perm'; return false; }
      }
      if (handle.kind === 'directory') {
        await idbPut(handle, 'dir');
        await idbDel('file');
        return await startFromDir(handle);
      }
      state.dir = null;
      state.mode = 'file';
      await idbPut(handle, 'file');
      await idbDel('dir');
      return await startWithFileHandle(handle);
    } catch (e) { state.status = 'err'; state.err = e.message; return false; }
  }
  async function disconnect() {
    stopLoop();
    state.dir = null; state.file = null; state.status = 'off'; state.last = 0; state.mode = null;
    await idbDel('file');
    await idbDel('dir');
    try { localStorage.removeItem(SHADOW_KEY); localStorage.removeItem(TOMB_KEY); } catch (e) {}
  }
  /* восстановление после запуска браузера: файл/папка известны, но доступ
     нужно подтвердить кликом (кнопка «Разрешить доступ») */
  async function init(opts) {
    state.onChange = opts && opts.onChange;
    try {
      var fh = await idbGet('file');
      if (fh) {
        state.file = fh; state.dir = null; state.mode = 'file';
        var pf = 'prompt';
        try { pf = await fh.queryPermission({ mode: 'readwrite' }); } catch (e) {}
        if (pf === 'granted') { await startWithFileHandle(fh); return { connected: true }; }
        state.status = 'perm';
        return { connected: false, needPermission: true };
      }
      var dir = await idbGet('dir');
      if (!dir) return { connected: false };
      state.dir = dir; state.mode = 'dir';
      var p = 'prompt';
      try { p = await dir.queryPermission({ mode: 'readwrite' }); } catch (e) {}
      if (p === 'granted') { await startFromDir(dir); return { connected: true }; }
      state.status = 'perm';
      return { connected: false, needPermission: true };
    } catch (e) {
      state.status = 'err'; state.err = e.message;
      return { connected: false, err: e.message };
    }
  }
  async function resumeWithPermission() {
    // Первая запись (writeThrough) сама спросит права у пользователя —
    // явный запрос «Not allowed to request permissions in this context»,
    // поэтому просто запускаем цикл.
    if (state.file) return await startWithFileHandle(state.file);
    if (state.dir)   return await startFromDir(state.dir);
    return connectFile();
  }

  return {
    init: init,
    connect: connect,
    connectFile: connectFile,
    connectDrop: connectDrop,
    disconnect: disconnect,
    resumeWithPermission: resumeWithPermission,
    cycle: cycle,
    mergeCycle: mergeCycle,
    SYNC_KEYS: SYNC_KEYS,
    /* подмена транспорта (тесты): SP_SYNC.useTransport({read, write}) */
    useTransport: function (t) { state.transport = t; state.status = 'ok'; },
    status: function () { return { status: state.status, err: state.err, last: state.last, connected: !!state.transport, mode: state.mode || null }; }
  };
})();
