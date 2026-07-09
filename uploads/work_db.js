/* ============================================================
   SmartPlan — БАЗА ДАННЫХ ВИДОВ РАБОТ УБиРОГС (work_db.js)
   Расширенные атрибуты: ордер, снег, погода, техника, сезон
   ============================================================ */
window.SP_WORK = (function () {
  'use strict';
  var KEY = 'smartplan_work_catalog';
  var AREAS = ['УБиРОГС'];
  var SCHEMA = 5; // новая версия — расширенные атрибуты

  // Каталог видов работ УБиРОГС со всеми атрибутами
  var DEFAULTS = [
    // --- Благоустройство после земляных работ ---
    { id: 'w1',  group: 'Благоустройство после земляных работ', name: 'Укладка асфальтобетонного покрытия', norm: 0.5,  unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 5,  season: 'Лето',     equipment: 'Асфальтоукладчик', min_workers: 4, opt_workers: 6 },
    { id: 'w2',  group: 'Благоустройство после земляных работ', name: 'Укладка тротуарной плитки',          norm: 0.4,  unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 0,  season: 'Круглый год', equipment: '—',               min_workers: 2, opt_workers: 4 },
    { id: 'w3',  group: 'Благоустройство после земляных работ', name: 'Устройство газона (посев)',           norm: 0.25, unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 5,  season: 'Весна-осень', equipment: '—',              min_workers: 2, opt_workers: 3 },
    // --- Ремонт зданий ГРП/ШРП ---
    { id: 'w4',  group: 'Ремонт зданий ГРП/ШРП',               name: 'Ремонт кровли ГРП/ШРП',              norm: 4.0,  unit: 'объект', needs_permit: false, depends_on_snow: false, min_temp: -10, season: 'Круглый год', equipment: 'Автовышка',     min_workers: 2, opt_workers: 3 },
    { id: 'w5',  group: 'Ремонт зданий ГРП/ШРП',               name: 'Ремонт стен и отмосток',             norm: 3.0,  unit: 'объект', needs_permit: false, depends_on_snow: false, min_temp: -5,  season: 'Круглый год', equipment: '—',              min_workers: 2, opt_workers: 4 },
    { id: 'w6',  group: 'Ремонт зданий ГРП/ШРП',               name: 'Ремонт отмостки (бетонные работы)',   norm: 0.6,  unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 5,   season: 'Лето',     equipment: 'Бетономешалка',   min_workers: 2, opt_workers: 4 },
    // --- Покраска ---
    { id: 'w7',  group: 'Покраска газопроводов и конструкций',  name: 'Покраска газопровода',               norm: 0.15, unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 5,   season: 'Лето',     equipment: 'Автовышка',      min_workers: 2, opt_workers: 3 },
    { id: 'w8',  group: 'Покраска газопроводов и конструкций',  name: 'Покраска металлоконструкций',         norm: 0.12, unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 0,   season: 'Круглый год', equipment: '—',             min_workers: 1, opt_workers: 2 },
    // --- Очистка от снега ---
    { id: 'w9',  group: 'Очистка от снега',                     name: 'Очистка территории от снега',         norm: 0.04, unit: 'м2', needs_permit: false, depends_on_snow: true,  min_temp: -50, season: 'Зима',     equipment: 'КДМ / Трактор',  min_workers: 1, opt_workers: 2 },
    { id: 'w10', group: 'Очистка от снега',                     name: 'Очистка подъездных путей',            norm: 0.06, unit: 'м2', needs_permit: false, depends_on_snow: true,  min_temp: -50, season: 'Зима',     equipment: 'КДМ',            min_workers: 1, opt_workers: 1 },
    // --- Расчистка лесопросек ---
    { id: 'w11', group: 'Расчистка лесопросек',                 name: 'Расчистка просеки (валка деревьев)',  norm: 8.0,  unit: 'га', needs_permit: true,  depends_on_snow: false, min_temp: -50, season: 'Зима',     equipment: 'Бензопила, Трактор', min_workers: 3, opt_workers: 5 },
    { id: 'w12', group: 'Расчистка лесопросек',                 name: 'Уборка порубочных остатков',          norm: 4.0,  unit: 'га', needs_permit: false, depends_on_snow: false, min_temp: -10, season: 'Зима',     equipment: 'Трактор',       min_workers: 2, opt_workers: 3 },
    // --- Иные строительно-восстановительные ---
    { id: 'w13', group: 'Иные СМР',                             name: 'Земляные работы (разработка грунта)',  norm: 2.0,  unit: 'объект', needs_permit: true,  depends_on_snow: false, min_temp: -5,  season: 'Круглый год', equipment: 'Экскаватор',  min_workers: 1, opt_workers: 2 },
    { id: 'w14', group: 'Иные СМР',                             name: 'Восстановление асфальта (ямочный)',    norm: 0.3,  unit: 'м2', needs_permit: false, depends_on_snow: false, min_temp: 5,   season: 'Лето',     equipment: '—',              min_workers: 2, opt_workers: 3 }
  ];

  var memoryDB = null;
  function load() {
    if (memoryDB) return memoryDB;
    try { var raw = localStorage.getItem(KEY); if (raw) memoryDB = JSON.parse(raw); } catch (e) {}
    return memoryDB;
  }
  function save(db) {
    memoryDB = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
    if (window.SP_CONFIG && window.SP_CONFIG.useServerApi) syncWithServer(db);
  }
  function init() {
    var db = load();
    if (!db || db.schema !== SCHEMA) { db = { schema: SCHEMA, areas: {} }; memoryDB = db; }
    return memoryDB;
  }
  function reloadFromCloud(cloudData) {
    if (cloudData && cloudData.areas) { memoryDB = cloudData; try { localStorage.setItem(KEY, JSON.stringify(cloudData)); } catch(e) {} }
  }
  function syncWithServer(db) {
    if (window.SP_DB && typeof window.SP_DB.syncToSupabase === 'function') { window.SP_DB.syncToSupabase(KEY, db); return; }
  }
  function newId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function ensureSeed() {
    var db = init();
    AREAS.forEach(function (area) {
      if (!db.areas[area] || !db.areas[area].length) {
        db.areas[area] = DEFAULTS.map(function (d) {
          return {
            id: d.id, group: d.group, name: d.name, norm: d.norm, unit: d.unit,
            needs_permit: d.needs_permit || false,
            depends_on_snow: d.depends_on_snow || false,
            min_temp: d.min_temp != null ? d.min_temp : -50,
            season: d.season || 'Круглый год',
            equipment: d.equipment || '—',
            min_workers: d.min_workers || 1,
            opt_workers: d.opt_workers || 2
          };
        });
      }
    });
    save(db);
    return Promise.resolve(db);
  }

  function getAreas() { return AREAS.slice(); }
  function getWorks(area) {
    var db = init();
    var arr = db.areas[area] || db.areas['УБиРОГС'] || DEFAULTS;
    return arr.map(function (w) { return Object.assign({}, w); });
  }
  function getWork(area, id) {
    var arr = getWorks(area);
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    for (var j = 0; j < DEFAULTS.length; j++) if (DEFAULTS[j].id === id) return DEFAULTS[j];
    return null;
  }
  function getWorkById(id) {
    var db = init();
    var keys = Object.keys(db.areas);
    for (var k = 0; k < keys.length; k++) {
      var arr = db.areas[keys[k]] || [];
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    }
    for (var j = 0; j < DEFAULTS.length; j++) if (DEFAULTS[j].id === id) return DEFAULTS[j];
    return null;
  }
  function addWork(area, data) {
    var db = init();
    if (!db.areas[area]) db.areas[area] = [];
    var w = {
      id: newId(), group: data.group || 'Без группы', name: data.name,
      norm: parseFloat(data.norm) || 0, unit: data.unit || 'объект',
      needs_permit: data.needs_permit === true || data.needs_permit === 'true',
      depends_on_snow: data.depends_on_snow === true || data.depends_on_snow === 'true',
      min_temp: parseFloat(data.min_temp),
      season: data.season || 'Круглый год',
      equipment: data.equipment || '—',
      min_workers: parseInt(data.min_workers) || 1,
      opt_workers: parseInt(data.opt_workers) || 2
    };
    db.areas[area].push(w); save(db);
    // Отправка на сервер
    if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
      fetch(window.SP_CONFIG.serverUrl + '/api/works/' + encodeURIComponent(area), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(w)
      }).catch(function() {});
    }
    return w;
  }
  function updateWork(area, id, data) {
    var db = init(); var arr = db.areas[area] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) {
      if (data.group !== undefined) arr[i].group = data.group;
      if (data.name !== undefined) arr[i].name = data.name;
      if (data.norm !== undefined) arr[i].norm = parseFloat(data.norm) || 0;
      if (data.unit !== undefined) arr[i].unit = data.unit;
      if (data.needs_permit !== undefined) arr[i].needs_permit = data.needs_permit === true || data.needs_permit === 'true';
      if (data.depends_on_snow !== undefined) arr[i].depends_on_snow = data.depends_on_snow === true || data.depends_on_snow === 'true';
      if (data.min_temp !== undefined) arr[i].min_temp = parseFloat(data.min_temp);
      if (data.season !== undefined) arr[i].season = data.season;
      if (data.equipment !== undefined) arr[i].equipment = data.equipment;
      if (data.min_workers !== undefined) arr[i].min_workers = parseInt(data.min_workers) || 1;
      if (data.opt_workers !== undefined) arr[i].opt_workers = parseInt(data.opt_workers) || 2;
      save(db);
      // Отправка на сервер
      if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
        fetch(window.SP_CONFIG.serverUrl + '/api/works/' + encodeURIComponent(area) + '/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(arr[i])
        }).catch(function() {});
      }
      return arr[i];
    }
    return null;
  }
  function deleteWork(area, id) {
    var db = init(); var arr = db.areas[area] || [];
    db.areas[area] = arr.filter(function (w) { return w.id !== id; });
    save(db);
    // Отправка на сервер
    if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
      fetch(window.SP_CONFIG.serverUrl + '/api/works/' + encodeURIComponent(area) + '/' + id, {
        method: 'DELETE'
      }).catch(function() {});
    }
  }

  return {
    ensureSeed: ensureSeed, getAreas: getAreas, getWorks: getWorks, getWork: getWork,
    getWorkById: getWorkById, addWork: addWork, updateWork: updateWork, deleteWork: deleteWork,
    DEFAULTS: DEFAULTS, reloadFromCloud: reloadFromCloud, SCHEMA: SCHEMA
  };
})();
