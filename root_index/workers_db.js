/* ============================================================
   SmartPlan — БАЗА ДАННЫХ РАБОТНИКОВ (workers_db.js)
   ------------------------------------------------------------
   Графики работы, время (8/12 ч), бригады, отсутствия и
   комментарии работников (мастера, слесаря, руководители).
   Хранение: localStorage + синхронизация с сервером по REST.
   Ключ работника = id пользователя из users_db.
   Формат: { schema: 1, workers: { uid: {
     hours: 8|12, sched: '5/2'|'2/2', cycle: 'YYYY-MM-DD',
     brigade: null|masterUid, comment: '', abs: { 'YYYY-MM-DD': 'причина' }
   } } }
   ============================================================ */
window.SP_WORKERS = (function () {
  'use strict';
  var KEY = 'smartplan_workers_db';
  var SCHEMA = 1;

  var memoryDB = null;
  function load() {
    if (memoryDB) return memoryDB;
    try { var raw = localStorage.getItem(KEY); if (raw) memoryDB = JSON.parse(raw); } catch (e) {}
    return memoryDB;
  }
  function save(db) {
    memoryDB = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
    syncWithServer(db);
  }
  function init() {
    var db = load();
    if (!db) { db = { schema: SCHEMA, workers: {} }; memoryDB = db; }
    else if (db.schema !== SCHEMA || !db.workers) {
      // обновление кода не теряет данные: снимок в smartplan_prev_, перенос в новую схему
      try { if (db.workers) localStorage.setItem('smartplan_prev_' + KEY, JSON.stringify(db)); } catch (e) {}
      db.schema = SCHEMA;
      if (!db.workers) db.workers = {};
      memoryDB = db;
    }
    return memoryDB;
  }
  function defaults() {
    return { hours: 8, sched: '5/2', cycle: '2026-01-05', brigade: null, prof: '', comment: '', abs: {} };
  }
  // Настройки работника (с значениями по умолчанию — копия)
  function getWorker(uid) {
    var db = init();
    var w = db.workers[uid];
    return Object.assign(defaults(), w || {});
  }
  // Частичное обновление настроек
  function setWorker(uid, patch) {
    var db = init();
    var merged = Object.assign(getWorker(uid), patch || {});
    db.workers[uid] = merged;
    save(db);
    return merged;
  }
  // Отсутствие: comment = null → снять отметку, иначе отметить (с комментарием или без)
  function setAbsence(uid, dateStr, comment) {
    var w = getWorker(uid);
    if (comment === null || comment === undefined) delete w.abs[dateStr];
    else w.abs[dateStr] = String(comment || '');
    return setWorker(uid, { abs: w.abs });
  }
  function reloadFromCloud(db) {
    if (db && db.workers) {
      memoryDB = { schema: SCHEMA, workers: db.workers };
      try { localStorage.setItem(KEY, JSON.stringify(memoryDB)); } catch (e) {}
    }
  }
  function syncWithServer(db) {
    try {
      (window.SP_NET ? SP_NET.send : fetch)((window.SP_CONFIG && SP_CONFIG.serverUrl ? SP_CONFIG.serverUrl : '') + '/api/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(db)
      }).catch(function () {});
    } catch (e) {}
  }

  return {
    KEY: KEY, SCHEMA: SCHEMA,
    getWorker: getWorker, setWorker: setWorker, setAbsence: setAbsence,
    reloadFromCloud: reloadFromCloud
  };
})();
