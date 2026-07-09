/* ============================================================
   SmartPlan — ЕДИНЫЙ КООРДИНАТОР БАЗ ДАННЫХ (db.js)
   ------------------------------------------------------------
   Надёжная двусторонняя синхронизация с сервером на Render.
   - При старте: загрузка ВСЕХ данных с сервера
   - При каждом изменении: немедленная отправка на сервер
   - Fallback на localStorage при недоступности сервера
   ============================================================ */
window.SP_DB = (function () {
  'use strict';
  var SESS_KEY = 'smartplan_session';
  var CFG = window.SP_CONFIG || {};
  var API = CFG.serverUrl || '';
  var USE_SERVER = CFG.useServerApi !== false;
  var EP = CFG.endpoints || {};
  var serverOnline = false;

  // ============================================================
  // НИЗКОУРОВНЕВЫЕ HTTP-ЗАПРОСЫ (всегда пытаются отправить)
  // ============================================================
  function apiGet(path) {
    return fetch(API + path, { method: 'GET' })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function apiPost(path, data) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiPut(path, data) {
    return fetch(API + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiDelete(path) {
    return fetch(API + path, { method: 'DELETE' })
      .then(function(r) { return r.json(); });
  }

  // ============================================================
  // ПРОВЕРКА ДОСТУПНОСТИ СЕРВЕРА
  // ============================================================
  function checkServer() {
    if (!USE_SERVER || !API) return Promise.resolve(false);
    return apiGet(EP.health)
      .then(function(data) {
        serverOnline = !!(data && data.status === 'ok');
        console.log(serverOnline ? '✅ Сервер доступен' : '❌ Сервер недоступен');
        return serverOnline;
      })
      .catch(function() {
        serverOnline = false;
        console.log('❌ Сервер недоступен');
        return false;
      });
  }

  // ============================================================
  // ПОЛНАЯ ЗАГРУЗКА ДАННЫХ С СЕРВЕРА → localStorage
  // ============================================================
  function syncFromServer() {
    if (!serverOnline) return Promise.resolve();
    console.log('🔄 Синхронизация данных с сервера...');

    var promises = [];

    // Пользователи
    promises.push(
      apiGet(EP.users).then(function(data) {
        if (data && data.users && data.users.length >= 0) {
          var dbData = { schema: 3, users: data.users };
          try { localStorage.setItem('smartplan_users_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_USERS_DB) window.SP_USERS_DB.reloadFromCloud(dbData);
          console.log('  👥 Пользователи: ' + data.users.length);
        }
      }).catch(function(e) { console.warn('  👥 Ошибка загрузки пользователей:', e.message); })
    );

    // Виды работ
    promises.push(
      apiGet(EP.works + '/УБиРОГС').then(function(data) {
        if (data && data.works) {
          var dbData = { schema: 5, areas: { 'УБиРОГС': data.works } };
          try { localStorage.setItem('smartplan_work_catalog', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_WORK) window.SP_WORK.reloadFromCloud(dbData);
          console.log('  🔧 Виды работ: ' + data.works.length);
        }
      }).catch(function(e) { console.warn('  🔧 Ошибка загрузки работ:', e.message); })
    );

    // Объекты
    promises.push(
      apiGet(EP.objects).then(function(data) {
        if (data && data.objects) {
          var dbData = { schema: 2, objects: data.objects };
          try { localStorage.setItem('smartplan_objects_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_OBJECTS) window.SP_OBJECTS.reloadFromCloud(dbData);
          console.log('  📍 Объекты: ' + data.objects.length);
        }
      }).catch(function(e) { console.warn('  📍 Ошибка загрузки объектов:', e.message); })
    );

    // Задания
    promises.push(
      apiGet(EP.tasks).then(function(data) {
        if (data && data.tasks) {
          var dbData = { schema: 3, tasks: data.tasks };
          try { localStorage.setItem('smartplan_tasks_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_TASKS) window.SP_TASKS.reloadFromCloud(dbData);
          console.log('  📋 Задания: ' + data.tasks.length);
        }
      }).catch(function(e) { console.warn('  📋 Ошибка загрузки заданий:', e.message); })
    );

    return Promise.all(promises).then(function() {
      console.log('✅ Синхронизация завершена');
      // Перерисовка интерфейса
      if (typeof window.reRenderCurrentScreen === 'function') {
        setTimeout(window.reRenderCurrentScreen, 50);
      }
    });
  }

  // ============================================================
  // ОТПРАВКА ИЗМЕНЕНИЙ НА СЕРВЕР (всегда пытается, без проверки serverOnline)
  // ============================================================

  // Пользователь: создать/обновить
  function sendUser(user) {
    if (!API) return;
    apiPost(EP.users, user)
      .then(function() { console.log('✅ Пользователь отправлен на сервер:', user.login); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки пользователя:', e.message); });
  }

  // Пользователь: удалить
  function sendUserDelete(id) {
    if (!API) return;
    apiDelete(EP.users + '/' + id)
      .then(function() { console.log('✅ Пользователь удалён на сервере:', id); })
      .catch(function(e) { console.warn('⚠️ Ошибка удаления пользователя:', e.message); });
  }

  // Работа: создать/обновить
  function sendWork(area, work) {
    if (!API) return;
    apiPost(EP.works + '/' + area, work)
      .then(function() { console.log('✅ Работа отправлена на сервер:', work.name); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки работы:', e.message); });
  }

  // Работа: удалить
  function sendWorkDelete(area, id) {
    if (!API) return;
    apiDelete(EP.works + '/' + area + '/' + id)
      .then(function() { console.log('✅ Работа удалена на сервере:', id); })
      .catch(function(e) { console.warn('⚠️ Ошибка удаления работы:', e.message); });
  }

  // Задание: создать/обновить
  function sendTask(task) {
    if (!API) return;
    // Нормализуем данные для сервера
    var payload = Object.assign({}, task);
    if (payload.works && Array.isArray(payload.works)) {
      // сервер ожидает works как массив (сам сериализует)
    }
    apiPost(EP.tasks, payload)
      .then(function() { console.log('✅ Задание отправлено на сервер:', task.id); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки задания:', e.message); });
  }

  // Задание: удалить
  function sendTaskDelete(id) {
    if (!API) return;
    apiDelete(EP.tasks + '/' + id)
      .then(function() { console.log('✅ Задание удалено на сервере:', id); })
      .catch(function(e) { console.warn('⚠️ Ошибка удаления задания:', e.message); });
  }

  // Объект: создать/обновить
  function sendObject(obj) {
    if (!API) return;
    apiPost(EP.objects, obj)
      .then(function() { console.log('✅ Объект отправлен на сервер:', obj.addr); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки объекта:', e.message); });
  }

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ ПРИ СТАРТЕ
  // ============================================================
  function ensureSeed() {
    return checkServer().then(function(online) {
      if (online) {
        // Сервер доступен — загружаем данные
        return syncFromServer().then(function() {
          // Заполняем сидами только то, чего нет (админ, базовые работы)
          return Promise.all([
            window.SP_USERS_DB.ensureSeed(),
            window.SP_WORK.ensureSeed(),
            window.SP_OBJECTS.ensureSeed(),
            window.SP_TASKS.ensureSeed()
          ]);
        }).then(function() {
          // Отправляем сиды на сервер (если их там ещё нет)
          sendSeedToServer();
        });
      } else {
        // Автономный режим
        return Promise.all([
          window.SP_USERS_DB.ensureSeed(),
          window.SP_WORK.ensureSeed(),
          window.SP_OBJECTS.ensureSeed(),
          window.SP_TASKS.ensureSeed()
        ]);
      }
    });
  }

  // Отправка начальных данных на сервер (для первого запуска)
  function sendSeedToServer() {
    if (!API) return;
    // Проверяем есть ли админ на сервере, если нет — отправляем
    apiGet(EP.users).then(function(data) {
      if (data && data.users && data.users.length === 0) {
        console.log('🌱 Отправка начальных данных на сервер...');
        apiPost(EP.seed, {}).catch(function() {});
      }
    }).catch(function() {});
  }

  // ============================================================
  // СЕССИЯ
  // ============================================================
  function getSession() {
    try {
      var id = localStorage.getItem(SESS_KEY);
      if (!id) return null;
      return window.SP_USERS_DB.getUser(id);
    } catch (e) { return null; }
  }
  function setSession(id) { try { localStorage.setItem(SESS_KEY, id); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SESS_KEY); } catch (e) {} }

  // ============================================================
  // ЭКСПОРТ / ИМПОРТ
  // ============================================================
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
      try { parsed = JSON.parse(text); } catch (e) { reject(new Error('Файл повреждён')); return; }
      var incoming;
      if (Array.isArray(parsed)) incoming = parsed;
      else if (parsed && Array.isArray(parsed.users)) incoming = parsed.users;
      else { reject(new Error('Неверный формат')); return; }

      // Отправка на сервер
      if (serverOnline && API) {
        apiPost(EP.users + '/bulk', { users: incoming, mode: mode })
          .then(function() { return syncFromServer(); })
          .then(function() { resolve({ mode: mode, added: incoming.length }); })
          .catch(function() {});
      }

      var KEY = 'smartplan_users_db';
      var added = 0;
      if (mode === 'replace') {
        var newDb = { schema: 3, users: incoming };
        try { localStorage.setItem(KEY, JSON.stringify(newDb)); } catch (e) {}
        if (window.SP_USERS_DB) window.SP_USERS_DB.reloadFromCloud(newDb);
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
        if (window.SP_USERS_DB) window.SP_USERS_DB.reloadFromCloud(mergedDb);
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

  // ============================================================
  // ПУБЛИЧНЫЙ API
  // ============================================================
  return {
    ensureSeed: ensureSeed,
    getSession: getSession, setSession: setSession, clearSession: clearSession,
    exportAll: exportAll, exportJSON: exportUsersJSON, importJSON: importUsersJSON, importAll: importAll,
    syncFromServer: syncFromServer, checkServer: checkServer,
    isServerOnline: function() { return serverOnline; },

    // Пользователи — проброс + синхронизация
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
      op.then(function(u) { sendUser(u); }).catch(function() {});
      return op;
    },
    updateUser: function(id, d) {
      var op = window.SP_USERS_DB.updateUser(id, d);
      op.then(function(u) { sendUser(Object.assign({ id: id }, d, u)); }).catch(function() {});
      return op;
    },
    deleteUser: function(id) {
      sendUserDelete(id);
      return window.SP_USERS_DB.deleteUser(id);
    },

    authenticate: function(l, p) {
      // Серверная аутентификация
      if (serverOnline && API) {
        return apiPost(EP.auth, { login: l, password: p })
          .then(function(data) {
            if (data && data.user) return data.user;
            return window.SP_USERS_DB.authenticate(l, p);
          })
          .catch(function() {
            return window.SP_USERS_DB.authenticate(l, p);
          });
      }
      return window.SP_USERS_DB.authenticate(l, p);
    },

    // Синхронизация работ и заданий
    syncWork: function(area, work, mode) {
      if (mode === 'delete') sendWorkDelete(area, work.id);
      else sendWork(area, work);
    },
    syncTask: function(task, mode) {
      if (mode === 'delete') sendTaskDelete(task.id);
      else sendTask(task);
    },
    syncObject: function(obj) { sendObject(obj); },
  };
})();
