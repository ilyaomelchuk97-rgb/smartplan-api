/* ============================================================
   SmartPlan — БАЗА ДАННЫХ ОБЪЕКТОВ И КООРДИНАТ (objects_db.js)
   ------------------------------------------------------------
   Хранит справочник объектов газораспределительной системы
   УП «МИНГАЗ» (ГРП, ШРП, газопроводы, задвижки) с координатами
   из МПК «Панорама». Поддерживает автономное хранение и
   синхронизацию с сервером по REST API.
   ============================================================ */
window.SP_OBJECTS = (function () {
  'use strict';
  var KEY = 'smartplan_objects_db';

  var DEFAULTS = [
    { id:'o1',  addr:'ГРП-1, ул. Ленина, 5',           type:'ГРП',     lat:53.9020, lng:27.5610, zu:4, area_obj:120 },
    { id:'o2',  addr:'ШРП-12, ул. Советская, 18',      type:'ШРП',     lat:53.9097, lng:27.5710, zu:0, area_obj:60 },
    { id:'o3',  addr:'ШРП-8, ул. Пушкина, 3',          type:'ШРП',     lat:53.9085, lng:27.5650, zu:2, area_obj:45 },
    { id:'o4',  addr:'ГРП-3, пр. Независимости, 76',   type:'ГРП',     lat:53.9180, lng:27.5820, zu:0, area_obj:200 },
    { id:'o5',  addr:'Трасса Г-101, км 2-4',           type:'Трасса',  lat:53.9030, lng:27.5380, zu:0, length_km:2 },
    { id:'o6',  addr:'ШРП-5, ул. Кирова, 12',          type:'ШРП',     lat:53.8940, lng:27.5640, zu:1, area_obj:50 },
    { id:'o7',  addr:'ГРП-7, ул. Ратомская, 30',       type:'ГРП',     lat:53.8780, lng:27.5490, zu:0, area_obj:180 },
    { id:'o8',  addr:'Трасса Г-205, км 1-3',           type:'Трасса',  lat:53.9130, lng:27.5440, zu:0, length_km:2 },
    { id:'o9',  addr:'Просека, трасса Г-101, км 5-8',  type:'Просека', lat:53.9200, lng:27.5500, zu:0, area_ha:3 },
    { id:'o10', addr:'Просека, трасса Г-205, км 4-7',  type:'Просека', lat:53.8950, lng:27.5300, zu:0, area_ha:5 },
    { id:'o11', addr:'ШРП-15, ул. Есенина, 7',         type:'ШРП',     lat:53.9210, lng:27.5880, zu:2, area_obj:55 },
    { id:'o12', addr:'ГРП-9, ул. Алибегова, 24',       type:'ГРП',     lat:53.8860, lng:27.5300, zu:0, area_obj:150 }
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
    if (window.SP_CONFIG && window.SP_CONFIG.useServerApi) {
      syncWithServer(db);
    }
  }
  function init() {
    var db = load();
    if (!db || db.schema !== 2) { db = { schema: 2, objects: [] }; memoryDB = db; }
    return memoryDB;
  }
  function reloadFromCloud(cloudData) {
    if (cloudData && cloudData.objects) {
      memoryDB = cloudData;
      try { localStorage.setItem(KEY, JSON.stringify(cloudData)); } catch(e) {}
    }
  }

  function syncWithServer(db) {
    if (window.SP_DB && typeof window.SP_DB.syncToSupabase === 'function') {
      window.SP_DB.syncToSupabase(KEY, db);
      return;
    }
    try {
      fetch(window.SP_CONFIG.serverUrl + window.SP_CONFIG.endpoints.objects, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(db.objects)
      }).catch(function() {});
    } catch(e) {}
  }

  function ensureSeed() {
    var db = init();
    if (!db.objects || !db.objects.length) {
      db.objects = DEFAULTS.map(function (o) { return Object.assign({}, o); });
      save(db);
    }
    return Promise.resolve(db);
  }

  function getObjects() { return init().objects.map(function (o) { return Object.assign({}, o); }); }
  function getObject(id) {
    var arr = init().objects;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }
  function getObjectByAddress(addr) {
    if (!addr) return null;
    var arr = init().objects;
    var clean = addr.toLowerCase().trim();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].addr.toLowerCase().indexOf(clean) !== -1 || clean.indexOf(arr[i].addr.toLowerCase()) !== -1) {
        return arr[i];
      }
    }
    return null;
  }
  function newId() { return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function addObject(data) {
    var db = init();
    var o = { id: newId(), addr: data.addr || 'Неизвестный адрес', type: data.type || 'Объект', lat: data.lat || null, lng: data.lng || null, zu: data.zu || 0 };
    db.objects.push(o); save(db); return o;
  }

  return {
    ensureSeed: ensureSeed, getObjects: getObjects, getObject: getObject,
    getObjectByAddress: getObjectByAddress, addObject: addObject, DEFAULTS: DEFAULTS, reloadFromCloud: reloadFromCloud
  };
})();
