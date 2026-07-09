/* ============================================================
   SmartPlan — ЕДИНЫЙ КООРДИНАТОР БАЗ ДАННЫХ (db.js)
   ------------------------------------------------------------
   Связывает фронтенд с бэкендом на Render.
   При недоступности сервера — fallback на localStorage.
   ============================================================ */
window.SP_DB = (function () {
  'use strict';
  var SESS_KEY = 'smartplan_session';
  var CFG = window.SP_CONFIG || {};
  var API = CFG.serverUrl || '';
  var USE_SERVER = CFG.useServerApi !== false;
  var EP = CFG.endpoints || {};

  // Проверка доступности сервера
  var serverOnline = false;
  function checkServer() {
    if (!USE_SERVER || !API) return Promise.resolve(false);
    return fetch(API + EP.health, { method: 'GET' })
      .then(function(r) { return r.ok; })
      .then(function(ok) { serverOnline = ok; return ok; })
      .catch(function() { serverOnline = false; return false; });
  }

  // === СИНХРОНИЗАЦИЯ С СЕРВЕРОМ ===
  // Загрузка всех данных с сервера → запись в localStorage → перезагрузка модулей
  function syncFromServer() {
    if (!USE_SERVER) return Promise.resolve();

    return Promise.all([
      // Пользователи
      fetch(API + EP.users).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.users) {
          localStorage.setItem('smartplan_users_db', JSON.stringify({ schema: 3, users: data.users }));
          if (window.SP_USERS_DB) window.SP_USERS_DB.reloadFromCloud({ schema: 3, users: data.users });
        }
      }).catch(function() {}),

      // Виды работ
      fetch(API + EP.works + '/УБиРОГС').then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.works) {
          localStorage.setItem('smartplan_work_catalog', JSON.stringify({ schema: 5, areas: { 'УБиРОГС': data.works } }));
          if (window.SP_WORK) window.SP_WORK.reloadFromCloud({ schema: 5, areas: { 'УБиРОГС': data.works } });
        }
      }).catch(function() {}),

      // Объекты
      fetch(API + EP.objects).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.objects) {
          localStorage.setItem('smartplan_objects_db', JSON.stringify({ schema: 2, objects: data.objects }));
          if (window.SP_OBJECTS) window.SP_OBJECTS.reloadFromCloud({ schema: 2, objects: data.objects });
        }
      }).catch(function() {}),

      // Задания
      fetch(API + EP.tasks).then(function(r) { return r.json(); }).then(function(data) {
        if (data && data.tasks) {
          localStorage.setItem('smartplan_tasks_db', JSON.stringify({ schema: 3, tasks: data.tasks }));
          if (window.SP_TASKS) window.SP_TASKS.reloadFromCloud({ schema: 3, tasks: data.tasks });
        }
      }).catch(function() {}),
    ]).then(function() {
      console.log('Синхронизация с сервером завершена');
      if (typeof window.reRenderCurrentScreen === 'function') {
        setTimeout(window.reRenderCurrentScreen, 100);
      }
    });
  }

  // === ОТПРАВКА ИЗМЕНЕНИЙ НА СЕРВЕР ===
  function postJSON(url, data) {
    if (!serverOnline) return Promise.resolve();
    return fetch(API + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).catch(function(e) { console.warn('Синхронизация не удалась:', e.message); });
  }

  function putJSON(url, data) {
    if (!serverOnline) return Promise.resolve();
    return fetch(API + url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).catch(function(e) { console.warn('Синхронизация не удалась:', e.message); });
  }

  function deleteJSON(url) {
    if (!serverOnline) return Promise.resolve();
    return fetch(API + url, { method: 'DELETE' }).catch(function(e) {});
  }

  // === ИНИЦИАЛИЗАЦИЯ ===
  function ensureSeed() {
    // Сначала проверяем сервер
    return checkServer().then(function(online) {
      if (online) {
        // Сервер доступен — синхронизируем данные
        return syncFromServer().then(function() {
          return Promise.all([
            window.SP_USERS_DB.ensureSeed(),
            window.SP_WORK.ensureSeed(),
            window.SP_OBJECTS.ensureSeed(),
            window.SP_TASKS.ensureSeed()
          ]);
        });
      } else {
        // Сервер недоступен — работаем автономно (localStorage)
        console.warn('Сервер недоступен, работа в автономном режиме');
        return Promise.all([
          window.SP_USERS_DB.ensureSeed(),
          window.SP_WORK.ensureSeed(),
          window.SP_OBJECTS.ensureSeed(),
          window.SP_TASKS.ensureSeed()
        ]);
      }
    });
  }

  // === СЕССИЯ ===
  function getSession() {
    try {
      var id = localStorage.getItem(SESS_KEY);
      if (!id) return null;
      return window.SP_USERS_DB.getUser(id);
    } catch (e) { return null; }
  }
  function setSession(id) { try { localStorage.setItem(SESS_KEY, id); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SESS_KEY); } catch (e) {} }

  // === СИНХРОНИЗАЦИЯ ОПЕРАЦИЙ С СЕРВЕРОМ ===

  // Пользователи
  function syncUserToServer(user, mode) {
    if (mode === 'delete') return deleteJSON(EP.users + '/' + user.id);
    return postJSON(EP.users, user);
  }

  // Виды работ
  function syncWorkToServer(area, work, mode) {
    if (mode === 'delete') return deleteJSON(EP.works + '/' + area + '/' + work.id);
    return postJSON(EP.works + '/' + area, work);
  }

  // Задания
  function syncTaskToServer(task, mode) {
    if (mode === 'delete') return deleteJSON(EP.tasks + '/' + task.id);
    return postJSON(EP.tasks, task);
  }

  // === ЭКСПОРТ/ИМПОРТ ===
  function exportAll() {
    return {
      version: '2.0', timestamp: Date.now(),
      users: window.SP_USERS_DB.getUsers(),
      works: window.SP_WORK.DEFAULTS,
      objects: window.SP_OBJECTS.getObjects(),
      tasks: window.SP_TASKS.getTasks()
    };
  }

  function exportUsersJSON() {
    var KEY = 'smartplan_users_db';
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (raw) return raw;
    var db = { schema: 3, users: window.SP_USERS_DB.getUsers() };
    return JSON.stringify(db, null, 2);
  }

  function importUsersJSON(text, mode) {
    return new Promise(function (resolve, reject) {
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (e) { reject(new Error('Файл повреждён или не является JSON')); return; }

      var incoming;
      if (Array.isArray(parsed)) incoming = parsed;
      else if (parsed && Array.isArray(parsed.users)) incoming = parsed.users;
      else { reject(new Error('Неверный формат файла')); return; }

      // Отправка на сервер если доступен
      if (serverOnline) {
        postJSON(EP.users + '/bulk', { users: incoming, mode: mode }).then(function() {
          return syncFromServer();
        }).then(function() { resolve({ mode: mode, added: incoming.length }); });
      }

      // Локальная обработка
      var KEY = 'smartplan_users_db';
      var added = 0;
      if (mode === 'replace') {
        var newDb = { schema: 3, users: incoming };
        try { localStorage.setItem(KEY, JSON.stringify(newDb)); } catch (e) {}
        if (window.SP_USERS_DB && window.SP_USERS_DB.reloadFromCloud) window.SP_USERS_DB.reloadFromCloud(newDb);
        added = incoming.length;
      } else {
        var existing = window.SP_USERS_DB.getUsers();
        var have = {};
        existing.forEach(function (u) { if (u.id) have[u.id] = 1; if (u.login) have[u.login.toLowerCase()] = 1; });
        incoming.forEach(function (u) {
          if (!u || !u.login) return;
          if (!have[u.id] && !have[u.login.toLowerCase()]) {
            existing.push(u); have[u.id] = 1; have[u.login.toLowerCase()] = 1; added++;
          }
        });
        var mergedDb = { schema: 3, users: existing };
        try { localStorage.setItem(KEY, JSON.stringify(mergedDb)); } catch (e) {}
        if (window.SP_USERS_DB && window.SP_USERS_DB.reloadFromCloud) window.SP_USERS_DB.reloadFromCloud(mergedDb);
      }
      resolve({ mode: mode, added: added });
    });
  }

  function importAll(data) {
    try {
      if (data && data.users) localStorage.setItem('smartplan_users_db', JSON.stringify({ schema: 3, users: data.users }));
      if (data && data.objects) localStorage.setItem('smartplan_objects_db', JSON.stringify({ schema: 2, objects: data.objects }));
      if (data && data.tasks) localStorage.setItem('smartplan_tasks_db', JSON.stringify({ schema: 3, tasks: data.tasks }));
      return ensureSeed();
    } catch (e) { return Promise.reject(e); }
  }

  // === API ===
  return {
    ensureSeed: ensureSeed,
    getSession: getSession, setSession: setSession, clearSession: clearSession,
    exportAll: exportAll, exportJSON: exportUsersJSON, importJSON: importUsersJSON, importAll: importAll,
    syncFromServer: syncFromServer, checkServer: checkServer,
    isServerOnline: function() { return serverOnline; },

    // Проброс методов пользователей
    getUsers: function() { return window.SP_USERS_DB.getUsers(); },
    getUser: function(id) { return window.SP_USERS_DB.getUser(id); },
    getUserByLogin: function(l) { return window.SP_USERS_DB.getUserByLogin(l); },
    getMasters: function() { return window.SP_USERS_DB.getMasters(); },
    countAdmins: function() { return window.SP_USERS_DB.countAdmins(); },
    count: function() { return window.SP_USERS_DB ? window.SP_USERS_DB.count() : 0; },

    downloadFile: function(filename, content) {
      try {
        var blob = new Blob([content], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
        return true;
      } catch(e) { return false; }
    },

    addUser: function(d) {
      var op = window.SP_USERS_DB.addUser(d);
      op.then(function(u) { syncUserToServer(u); });
      return op;
    },
    updateUser: function(id, d) {
      var op = window.SP_USERS_DB.updateUser(id, d);
      op.then(function(u) { syncUserToServer(Object.assign({id: id}, d)); });
      return op;
    },
    deleteUser: function(id) {
      syncUserToServer({id: id}, 'delete');
      return window.SP_USERS_DB.deleteUser(id);
    },
    authenticate: function(l, p) {
      // Пробуем серверную аутентификацию
      if (serverOnline) {
        return fetch(API + EP.auth, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login: l, password: p })
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data && data.user) return data.user;
          return window.SP_USERS_DB.authenticate(l, p);
        }).catch(function() {
          return window.SP_USERS_DB.authenticate(l, p);
        });
      }
      return window.SP_USERS_DB.authenticate(l, p);
    },

    // Синхронизация работ и заданий
    syncWork: syncWorkToServer,
    syncTask: syncTaskToServer,
  };
})();
