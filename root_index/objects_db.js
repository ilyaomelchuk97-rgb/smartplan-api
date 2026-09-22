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
    { id:'o1',  type:'ГРП', num:'1',  addr:'ул. Ленина, 5',                  lat:53.9020, lng:27.5610, zu:4, area_obj:120 },
    { id:'o2',  type:'ШРП', num:'12', addr:'ул. Советская, 18',              lat:53.9097, lng:27.5710, zu:0, area_obj:60 },
    { id:'o3',  type:'ШРП', num:'8',  addr:'ул. Пушкина, 3',                 lat:53.9085, lng:27.5650, zu:2, area_obj:45 },
    { id:'o4',  type:'ГРП', num:'3',  addr:'пр. Независимости, 76',          lat:53.9180, lng:27.5820, zu:0, area_obj:200 },
    { id:'o5',  type:'Трасса',  addr:'Трасса Г-101, км 2-4',                 lat:53.9030, lng:27.5380, zu:0, length_km:2 },
    { id:'o6',  type:'ШРП', num:'5',  addr:'ул. Кирова, 12',                 lat:53.8940, lng:27.5640, zu:1, area_obj:50 },
    { id:'o7',  type:'ГРП', num:'7',  addr:'ул. Ратомская, 30',              lat:53.8780, lng:27.5490, zu:0, area_obj:180 },
    { id:'o8',  type:'Трасса',  addr:'Трасса Г-205, км 1-3',                 lat:53.9130, lng:27.5440, zu:0, length_km:2 },
    { id:'o9',  type:'Просека', addr:'Просека, трасса Г-101, км 5-8',        lat:53.9200, lng:27.5500, zu:0, area_ha:3 },
    { id:'o10', type:'Просека', addr:'Просека, трасса Г-205, км 4-7',        lat:53.8950, lng:27.5300, zu:0, area_ha:5 },
    { id:'o11', type:'ШРП', num:'15', addr:'ул. Есенина, 7',                 lat:53.9210, lng:27.5880, zu:2, area_obj:55 },
    { id:'o12', type:'ГРП', num:'9',  addr:'ул. Алибегова, 24',              lat:53.8860, lng:27.5300, zu:0, area_obj:150 }
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
    if (!db) { db = { schema: 2, objects: [] }; memoryDB = db; }
    else if (db.schema !== 2) {
      // ОБНОВЛЕНИЕ КОДА НЕ ТЕРЯЕТ ДАННЫЕ: прежний снимок — в smartplan_prev_,
      // коллекция переносится в новую схему (лишние поля не мешают работе)
      try { localStorage.setItem('smartplan_prev_' + KEY, JSON.stringify(db)); } catch (e) {}
      db.schema = 2;
      if (!db.objects) db.objects = [];
      memoryDB = db;
    }
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
      (window.SP_NET ? SP_NET.send : fetch)(window.SP_CONFIG.serverUrl + window.SP_CONFIG.endpoints.objects, {
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
    var o = {
      id: newId(),
      addr: data.addr || '',
      type: data.type || 'Объект',
      num: data.num != null ? String(data.num) : '',
      lat: (data.lat != null && data.lat !== '') ? parseFloat(data.lat) : null,
      lng: (data.lng != null && data.lng !== '') ? parseFloat(data.lng) : null,
      poly: (data.poly && data.poly.length >= 3) ? data.poly : null, // область на карте: [[lat,lng],...]
      descr: data.descr || '', // описание области (показывается в облачке на карте)
      color: (data.color && /^#[0-9a-fA-F]{3,8}$/.test(data.color)) ? data.color : '', // цвет области
      respId: data.respId || '',   // ответственный за объект (id пользователя)
      respName: data.respName || '', // ответственный за объект (ФИО)
      zu: data.zu || 0,
      area_obj: data.area_obj || 0, length_km: data.length_km || 0, area_ha: data.area_ha || 0
    };
    if (!o.addr && o.num) o.addr = '';
    db.objects.push(o); save(db);
    // Отправка на сервер
    if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
      (window.SP_NET ? SP_NET.send : fetch)(window.SP_CONFIG.serverUrl + '/api/objects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(o)
      }).catch(function() {});
    }
    return o;
  }

  function updateObject(id, data) {
    var db = init();
    for (var i = 0; i < db.objects.length; i++) {
      if (db.objects[i].id === id) {
        if (data.type !== undefined) db.objects[i].type = data.type;
        if (data.num !== undefined) db.objects[i].num = String(data.num == null ? '' : data.num);
        if (data.addr !== undefined) db.objects[i].addr = data.addr;
        if (data.lat !== undefined) db.objects[i].lat = (data.lat === null || data.lat === '') ? null : parseFloat(data.lat);
        if (data.lng !== undefined) db.objects[i].lng = (data.lng === null || data.lng === '') ? null : parseFloat(data.lng);
        if (data.poly !== undefined) db.objects[i].poly = (data.poly && data.poly.length >= 3) ? data.poly : null;
        if (data.descr !== undefined) db.objects[i].descr = data.descr || '';
        if (data.color !== undefined) db.objects[i].color = (data.color && /^#[0-9a-fA-F]{3,8}$/.test(data.color)) ? data.color : '';
        if (data.respId !== undefined) db.objects[i].respId = data.respId || '';
        if (data.respName !== undefined) db.objects[i].respName = data.respName || '';
        if (data.zu !== undefined) db.objects[i].zu = data.zu;
        if (data.area_obj !== undefined) db.objects[i].area_obj = data.area_obj;
        if (data.length_km !== undefined) db.objects[i].length_km = data.length_km;
        if (data.area_ha !== undefined) db.objects[i].area_ha = data.area_ha;
        save(db);
        var o = db.objects[i];
        // Отправка на сервер
        if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
          (window.SP_NET ? SP_NET.send : fetch)(window.SP_CONFIG.serverUrl + '/api/objects/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(o)
          }).catch(function() {});
        }
        return Object.assign({}, o);
      }
    }
    return null;
  }

  function deleteObject(id) {
    var db = init();
    db.objects = db.objects.filter(function (o) { return o.id !== id; });
    save(db);
    // Отправка на сервер
    if (window.SP_CONFIG && window.SP_CONFIG.serverUrl) {
      (window.SP_NET ? SP_NET.send : fetch)(window.SP_CONFIG.serverUrl + '/api/objects/' + encodeURIComponent(id), {
        method: 'DELETE'
      }).catch(function() {});
    }
  }

  return {
    ensureSeed: ensureSeed, getObjects: getObjects, getObject: getObject,
    getObjectByAddress: getObjectByAddress, addObject: addObject,
    updateObject: updateObject, deleteObject: deleteObject,
    DEFAULTS: DEFAULTS, reloadFromCloud: reloadFromCloud
  };
})();
