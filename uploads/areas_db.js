/* ============================================================
   SmartPlan — БАЗА ДАННЫХ УЧАСТКОВ (areas_db.js)
   ------------------------------------------------------------
   Справочник участков УП «МИНГАЗ». Участки используются:
   - в справочнике видов работ (нормы времени по участкам),
   - у пользователей (мастер / начальник участка),
   - в фильтрах панели мониторинга.
   Хранение: localStorage + синхронизация с сервером (REST).
   ============================================================ */
window.SP_AREAS = (function () {
  'use strict';
  var KEY = 'smartplan_areas_db';
  var SCHEMA = 1;
  var DEFAULTS = [{ id: 'a_ubirogs', name: 'УБиРОГС' }];

  var memoryDB = null;
  function load() {
    if (memoryDB) return memoryDB;
    try { var raw = localStorage.getItem(KEY); if (raw) memoryDB = JSON.parse(raw); } catch (e) {}
    return memoryDB;
  }
  function save(db) {
    memoryDB = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
  }
  function init() {
    var db = load();
    if (!db) { db = { schema: SCHEMA, areas: [] }; memoryDB = db; }
    else if (db.schema !== SCHEMA) {
      // ОБНОВЛЕНИЕ КОДА НЕ ТЕРЯЕТ ДАННЫЕ: прежний снимок — в smartplan_prev_,
      // коллекция переносится в новую схему (лишние поля не мешают работе)
      try { localStorage.setItem('smartplan_prev_' + KEY, JSON.stringify(db)); } catch (e) {}
      db.schema = SCHEMA;
      if (!db.areas) db.areas = [];
      memoryDB = db;
    }
    return memoryDB;
  }
  function reloadFromCloud(cloudData) {
    if (cloudData && cloudData.areas) {
      memoryDB = cloudData;
      try { localStorage.setItem(KEY, JSON.stringify(cloudData)); } catch (e) {}
    }
  }
  function newId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function apiUrl(path) { return (window.SP_CONFIG && window.SP_CONFIG.serverUrl ? SP_CONFIG.serverUrl : '') + path; }

  function ensureSeed() {
    var db = init();
    if (!db.areas.length) {
      db.areas = DEFAULTS.map(function (a) { return { id: a.id, name: a.name }; });
      save(db);
    }
    return Promise.resolve(db);
  }

  function getAll() { return init().areas.map(function (a) { return Object.assign({}, a); }); }
  function getAreas() { return init().areas.map(function (a) { return a.name; }); }
  function getArea(name) {
    var arr = init().areas;
    for (var i = 0; i < arr.length; i++) if (arr[i].name === name) return Object.assign({}, arr[i]);
    return null;
  }
  function hasArea(name) { return !!getArea(name); }

  function addArea(name) {
    name = (name || '').trim();
    if (!name) return { ok: false, error: 'Введите название участка' };
    if (hasArea(name)) return { ok: false, error: 'Участок «' + name + '» уже существует' };
    var db = init();
    var a = { id: newId(), name: name, created: Date.now() };
    db.areas.push(a); save(db);
    // Сервер (upsert по названию)
    try {
      (window.SP_NET ? SP_NET.send : fetch)(apiUrl('/api/areas'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a)
      }).catch(function () {});
    } catch (e) {}
    return { ok: true, area: a };
  }

  function renameArea(id, newName) {
    newName = (newName || '').trim();
    var db = init();
    var a = null;
    for (var i = 0; i < db.areas.length; i++) if (db.areas[i].id === id) { a = db.areas[i]; break; }
    if (!a) return { ok: false, error: 'Участок не найден' };
    if (!newName) return { ok: false, error: 'Введите название участка' };
    if (newName === a.name) return { ok: true, area: a };
    for (var j = 0; j < db.areas.length; j++) if (db.areas[j].name === newName) return { ok: false, error: 'Участок «' + newName + '» уже существует' };
    var oldName = a.name;
    a.name = newName; save(db);
    // Виды работ и пользователи переносит вызывающий код (WORK.renameArea, DB.updateUser),
    // сервер обновляет works.area и users.area внутри PUT /api/areas/:id
    try {
      (window.SP_NET ? SP_NET.send : fetch)(apiUrl('/api/areas/' + encodeURIComponent(id)), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName, oldName: oldName })
      }).catch(function () {});
    } catch (e) {}
    return { ok: true, area: a, oldName: oldName, name: newName };
  }

  function deleteArea(id) {
    var db = init();
    var a = null;
    for (var i = 0; i < db.areas.length; i++) if (db.areas[i].id === id) { a = db.areas[i]; break; }
    if (!a) return { ok: false, error: 'Участок не найден' };
    db.areas = db.areas.filter(function (x) { return x.id !== id; });
    save(db);
    try {
      (window.SP_NET ? SP_NET.send : fetch)(apiUrl('/api/areas/' + encodeURIComponent(id)), { method: 'DELETE' }).catch(function () {});
    } catch (e) {}
    return { ok: true, area: a };
  }

  // Импорт из Excel: добавить недостающие участки
  function importAreas(names) {
    var added = 0, skipped = 0;
    (names || []).forEach(function (n) {
      n = String(n || '').trim();
      if (!n) return;
      if (hasArea(n)) { skipped++; return; }
      addArea(n);
      added++;
    });
    return { added: added, skipped: skipped };
  }

  return {
    KEY: KEY, SCHEMA: SCHEMA, DEFAULTS: DEFAULTS,
    ensureSeed: ensureSeed, reloadFromCloud: reloadFromCloud,
    getAll: getAll, getAreas: getAreas, getArea: getArea, hasArea: hasArea,
    addArea: addArea, renameArea: renameArea, deleteArea: deleteArea, importAreas: importAreas
  };
})();
