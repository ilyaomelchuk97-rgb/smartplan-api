/* ============================================================
   SmartPlan — БАЗА ДАННЫХ ЗАДАНИЙ УБиРОГС (tasks_db.js)
   Расширенные поля: объём, тип дедлайна, погода, техника
   ============================================================ */
window.SP_TASKS = (function () {
  'use strict';
  var KEY = 'smartplan_tasks_db';
  var SCHEMA = 3;

  var TASK_SEED = [];

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
    if (!db || db.schema !== SCHEMA) { db = { schema: SCHEMA, tasks: [] }; memoryDB = db; }
    return memoryDB;
  }
  function reloadFromCloud(cloudData) {
    if (cloudData && cloudData.tasks) { memoryDB = cloudData; try { localStorage.setItem(KEY, JSON.stringify(cloudData)); } catch(e) {} }
  }
  function syncWithServer(db) {
    if (window.SP_DB && typeof window.SP_DB.syncToSupabase === 'function') { window.SP_DB.syncToSupabase(KEY, db); return; }
  }

  function ensureSeed() {
    var db = init();
    if (!db.tasks || !db.tasks.length) { db.tasks = TASK_SEED.slice(); save(db); }
    return Promise.resolve(db);
  }

  function getTasks() { return init().tasks; }
  function getTask(id) { var arr = init().tasks; for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function addTask(data) {
    var db = init();
    var t = Object.assign({ id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) }, data);
    db.tasks.push(t); save(db);
    // Синхронизация с сервером
    if (window.SP_DB && window.SP_DB.syncTask) window.SP_DB.syncTask(t);
    return t;
  }
  function updateTask(id, data) {
    var db = init(), t = null;
    for (var i = 0; i < db.tasks.length; i++) if (db.tasks[i].id === id) { t = db.tasks[i]; break; }
    if (!t) return null;
    Object.assign(t, data);
    save(db);
    // Синхронизация с сервером
    if (window.SP_DB && window.SP_DB.syncTask) window.SP_DB.syncTask(t);
    return t;
  }
  function deleteTask(id) {
    var db = init();
    db.tasks = db.tasks.filter(function (t) { return t.id !== id; });
    save(db);
    // Синхронизация с сервером
    if (window.SP_DB && window.SP_DB.syncTask) window.SP_DB.syncTask({ id: id }, 'delete');
  }
  function resetSeed() { localStorage.removeItem(KEY); memoryDB = null; return ensureSeed(); }

  return {
    ensureSeed: ensureSeed, getTasks: getTasks, getTask: getTask,
    addTask: addTask, updateTask: updateTask, deleteTask: deleteTask,
    resetSeed: resetSeed, reloadFromCloud: reloadFromCloud, TASK_SEED: TASK_SEED
  };
})();
