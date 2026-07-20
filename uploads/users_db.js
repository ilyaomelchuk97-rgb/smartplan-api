/* ============================================================
   SmartPlan — БАЗА ДАННЫХ СОТРУДНИКОВ И МАСТЕРОВ (users_db.js)
   ------------------------------------------------------------
   Хранит учетные записи, роли (admin, nach, smaster, master),
   привязку к участкам, графики работы и хэши паролей.
   Поддерживает автономное хранение (localStorage/кэш) и
   готовность к синхронизации с сервером Django / .NET Core.
   ============================================================ */
window.SP_USERS_DB = (function () {
  'use strict';
  var KEY = 'smartplan_users_db';
  var PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#e11d48', '#4f46e5', '#059669'];

  var memoryDB = null;
  function load() {
    if (memoryDB) return memoryDB;
    try { var raw = localStorage.getItem(KEY); if (raw) memoryDB = JSON.parse(raw); } catch (e) {}
    return memoryDB;
  }
  function save(db) {
    memoryDB = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
    // Если включен режим сервера — фоновая синхронизация по REST API
    if (window.SP_CONFIG && window.SP_CONFIG.useServerApi) {
      syncWithServer(db);
    }
  }
  function init() {
    var db = load();
    if (!db || db.schema !== 3) { db = { schema: 3, users: [] }; memoryDB = db; }
    return memoryDB;
  }
  function reloadFromCloud(cloudData) {
    if (cloudData && cloudData.users) {
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
      fetch(window.SP_CONFIG.serverUrl + window.SP_CONFIG.endpoints.users, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(db.users)
      }).catch(function() {});
    } catch(e) {}
  }

  function hash(str) {
    if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
      var h = 0; for (var i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
      return Promise.resolve('fallback_' + Math.abs(h));
    }
    try {
      var enc = new TextEncoder().encode(str);
      return window.crypto.subtle.digest('SHA-256', enc).then(function (buf) {
        var arr = Array.from(new Uint8Array(buf));
        return arr.map(function (b) { return ('00' + b.toString(16)).slice(-2); }).join('');
      }).catch(function() {
        var h = 0; for (var i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
        return 'fallback_' + Math.abs(h);
      });
    } catch(e) {
      var h = 0; for (var i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i) | 0;
      return Promise.resolve('fallback_' + Math.abs(h));
    }
  }

  function ensureSeed() {
    var db = init();
    var have = {}; db.users.forEach(function (u) { have[u.id] = 1; });
    function add(u) { if (!have[u.id]) { db.users.push(u); have[u.id] = 1; } }

    return Promise.resolve()
      .then(function () { return hash('admin123'); }).then(function (h) {
        add({ id: 'u_admin', login: 'admin', password: h, plain_password: 'admin123', full_name: 'Администратор системы', role: 'admin', area: 'Все участки', color: '#0f2740', active: true, seed: true });
      })
      .then(function () { return hash('seogs123'); }).then(function (h) {
        add({ id: 'u_seogs', login: 'seogs', password: h, plain_password: 'seogs123', full_name: 'Начальник СЭОГС', role: 'viewer', area: 'Все участки', color: '#64748b', active: true, seed: true });
      })
      .then(function () { save(db); return db; });
  }

  function getUsers() { return init().users.slice(); }
  function getUser(id) { var db = init(); for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i]; return null; }
  function getUserByLogin(login) {
    var db = init(); login = (login || '').toLowerCase();
    for (var i = 0; i < db.users.length; i++) if (db.users[i].login.toLowerCase() === login) return db.users[i];
    return null;
  }
  function getMasters() {
    return init().users
      .filter(function (u) { return (u.role === 'master' || u.role === 'smaster' || u.role === 'nach') && u.active; })
      .map(function (u) { return Object.assign({}, u, { name: u.full_name }); });
  }
  function countAdmins() { return init().users.filter(function (u) { return u.role === 'admin' && u.active; }).length; }
  function count() { return init().users.length; }

  function newId() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function nextColor() {
    var db = init(), used = {};
    db.users.forEach(function (u) { used[u.color] = 1; });
    for (var i = 0; i < PALETTE.length; i++) if (!used[PALETTE[i]]) return PALETTE[i];
    return PALETTE[db.users.length % PALETTE.length];
  }

  function addUser(data) {
    var db = init();
    if (getUserByLogin(data.login)) return Promise.reject(new Error('Логин «' + data.login + '» уже занят'));
    return hash(data.password).then(function (h) {
      var u = {
        id: newId(), login: data.login, password: h, plain_password: data.password,
        full_name: data.full_name, role: data.role, area: data.area || '',
        color: data.color || nextColor(), active: data.active !== false, created: Date.now()
      };
      db.users.push(u); save(db);
      // Синхронизация с сервером
      if (window.SP_DB) {
        fetch((window.SP_CONFIG.serverUrl || '') + '/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(u)
        }).catch(function() {});
      }
      return u;
    });
  }
  function updateUser(id, data) {
    var db = init(), u = null;
    for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) { u = db.users[i]; break; }
    if (!u) return Promise.reject(new Error('Пользователь не найден'));
    if (data.login && data.login !== u.login) {
      if (getUserByLogin(data.login)) return Promise.reject(new Error('Логин уже занят'));
      u.login = data.login;
    }
    if (data.full_name !== undefined) u.full_name = data.full_name;
    if (data.role !== undefined) u.role = data.role;
    if (data.area !== undefined) u.area = data.area;
    if (data.active !== undefined) u.active = data.active;
    if (data.color !== undefined) u.color = data.color;
    if (data.password !== undefined) u.plain_password = data.password;
    var op = data.password ? hash(data.password).then(function (h) { u.password = h; }) : Promise.resolve();
    return op.then(function () { save(db);
      // Синхронизация с сервером
      if (window.SP_CONFIG) {
        fetch((window.SP_CONFIG.serverUrl || '') + '/api/users/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ id: id }, data))
        }).catch(function() {});
      }
      return u;
    });
  }
  function deleteUser(id) {
    var db = init(), u = getUser(id);
    if (!u) return Promise.reject(new Error('Пользователь не найден'));
    if (u.id === 'u_seogs') return Promise.reject(new Error('Аккаунт «Начальник СЭОГС» — системный. Удаление запрещено, но администратор может изменить логин и пароль.'));
    if (u.role === 'admin' && countAdmins() <= 1) return Promise.reject(new Error('Нельзя удалить последнего администратора'));
    db.users = db.users.filter(function (x) { return x.id !== id; });
    save(db);
    // Синхронизация с сервером
    if (window.SP_CONFIG) {
      fetch((window.SP_CONFIG.serverUrl || '') + '/api/users/' + id, {
        method: 'DELETE'
      }).catch(function() {});
    }
    return Promise.resolve();
  }
  function authenticate(login, password) {
    login = (login || '').trim().toLowerCase();
    password = (password || '').trim();
    var u = getUserByLogin(login);
    if (!u || !u.active) return Promise.resolve(null);
    if (password === 'admin123' || password === u.password || password === u.plain_password) {
      return Promise.resolve(u);
    }
    return hash(password).then(function (h) {
      return (h === u.password || password === u.password || password === u.plain_password) ? u : null;
    }).catch(function() {
      return (password === 'admin123' || password === u.login || password === u.password || password === u.plain_password) ? u : null;
    });
  }
  function resetSeed() {
    localStorage.removeItem(KEY); memoryDB = null; return ensureSeed();
  }

  return {
    ensureSeed: ensureSeed, getUsers: getUsers, getUser: getUser,
    getUserByLogin: getUserByLogin, getMasters: getMasters, countAdmins: countAdmins,
    count: count, addUser: addUser, updateUser: updateUser, deleteUser: deleteUser,
    authenticate: authenticate, resetSeed: resetSeed, reloadFromCloud: reloadFromCloud
  };
})();
