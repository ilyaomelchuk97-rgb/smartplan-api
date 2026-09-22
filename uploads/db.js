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

  /* ============================================================
     СЕТЬ: офлайн-баннер + ОЧЕРЕДЬ ОТПРАВКИ (outbox)
     Если сеть недоступна — изменение пишется в очередь localStorage
     и автоматически уходит на сервер при восстановлении соединения.
     Все отправки идемпотентны (upsert по id), повтор безопасен.
     ============================================================ */
  var OUTBOX_KEY = 'smartplan_outbox';
  function outboxRead() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch (e) { return []; }
  }
  function outboxWrite(q) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); } catch (e) {}
    netBannerUpdate();
  }
  function netBannerUpdate() {
    var b = document.getElementById('net-banner');
    if (!b) return;
    var q = outboxRead();
    if (!navigator.onLine) {
      b.textContent = q.length
        ? '🌐 Нет соединения — ' + q.length + ' ' + (q.length === 1 ? 'изменение ждёт' : 'изменений ждут') + ' отправки (уйдут на сервер автоматически)'
        : '🌐 Нет соединения — изменения сохраняются локально';
      b.classList.add('show');
    } else {
      b.classList.remove('show');
    }
  }
  // Отправка с постановкой в очередь при отказе сети.
  // Сигнатура совместима с fetch(url, opts) — вызовы меняются один в один.
  function netSend(url, opts) {
    opts = opts || {};
    return fetch(url, opts).catch(function (err) {
      try {
        var q = outboxRead();
        q.push({ url: url, opts: opts, ts: Date.now() });
        if (q.length > 500) q = q.slice(-500); // страховка от переполнения
        outboxWrite(q);
      } catch (e) {}
      throw err; // вызывающий код работает как раньше (offline — «не отправилось»)
    });
  }
  // Повторная отправка очереди (по одному, останавливаемся при первой неудаче)
  function netFlush() {
    var q = outboxRead();
    if (!q.length || !navigator.onLine) { netBannerUpdate(); return; }
    var item = q[0];
    fetch(item.url, item.opts).then(function () {
      q.shift();
      outboxWrite(q);
      console.log('📤 Очередь: отправлено, осталось ' + q.length);
      netFlush(); // следующее
    }).catch(function () {
      // сеть снова пропала — очередь остаётся
      netBannerUpdate();
    });
  }
  window.SP_NET = { send: netSend, flush: netFlush, banner: netBannerUpdate };
  // Keep-alive: пока у кого-то открыто приложение — пингуем сервер каждые 10 минут,
  // чтобы бесплатный инстанс Render не засыпал (холодный старт = 30–50 сек ожидания)
  if (CFG.useServerApi && CFG.serverUrl) {
    setInterval(function () {
      try { fetch(CFG.serverUrl + '/api/health').catch(function () {}); } catch (e) {}
    }, 10 * 60 * 1000);
  }
  window.addEventListener('online', function () { console.log('🌐 Сеть восстановлена — отправляем очередь'); netFlush(); });
  window.addEventListener('offline', function () { netBannerUpdate(); });
  // при загрузке: баннер по состоянию сети + попытка отправить накопленное
  setTimeout(function () { netBannerUpdate(); netFlush(); }, 1500);

  // ============================================================
  // НИЗКОУРОВНЕВЫЕ HTTP-ЗАПРОСЫ (всегда пытаются отправить)
  // ============================================================
    function apiGet(path) {
    return fetch(API + path, { method: 'GET', mode: 'cors' })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function(e) { throw e; });
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
        return serverOnline;
      })
      .catch(function() {
        serverOnline = false;
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
          // MERGE: не затираем локальных пользователей, а объединяем
          var existingUsers = window.SP_USERS_DB ? window.SP_USERS_DB.getUsers() : [];
          var haveIds = {}; existingUsers.forEach(function(u) { if (u.id) haveIds[u.id] = u; });
          var haveLogins = {}; existingUsers.forEach(function(u) { if (u.login) haveLogins[u.login.toLowerCase()] = u; });
          
          data.users.forEach(function(u) {
            if (u.id && haveIds[u.id]) {
              // Обновляем существующего (сервер приоритетнее для общих полей)
              Object.assign(haveIds[u.id], u);
            } else if (u.login && haveLogins[u.login.toLowerCase()]) {
              Object.assign(haveLogins[u.login.toLowerCase()], u);
            } else {
              // Новый пользователь с сервера
              existingUsers.push(u);
              haveIds[u.id] = u;
              if (u.login) haveLogins[u.login.toLowerCase()] = u;
            }
          });
          
          var dbData = { schema: 3, users: existingUsers };
          try { localStorage.setItem('smartplan_users_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_USERS_DB) window.SP_USERS_DB.reloadFromCloud(dbData);
          console.log('  👥 Пользователи: ' + existingUsers.length);
        }
      }).catch(function(e) { console.warn('  👥 Ошибка загрузки пользователей:', e.message); })
    );

    // Участки
    promises.push(
      apiGet((EP.areas || '/api/areas')).then(function(data) {
        if (data && data.areas) {
          var dbData = { schema: 1, areas: data.areas };
          try { localStorage.setItem('smartplan_areas_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_AREAS) window.SP_AREAS.reloadFromCloud(dbData);
          console.log('  🗺 Участки: ' + data.areas.length);
        }
      }).catch(function(e) { console.warn('  🗺 Ошибка загрузки участков:', e.message); })
    );

    // Виды работ (по ВСЕМ участкам из справочника, с сохранением локальных)
    promises.push(
      (function () {
        var areaNames = (window.SP_AREAS && window.SP_AREAS.getAreas) ? window.SP_AREAS.getAreas() : ['УБиРОГС'];
        return Promise.all(areaNames.map(function (an) {
          return apiGet(EP.works + '/' + encodeURIComponent(an)).then(function (data) {
            if (data && data.works) return { area: an, works: data.works };
            return null;
          }).catch(function () { return null; });
        })).then(function (results) {
          // Начинаем с локального каталога — участки, которых нет на сервере, не теряем
          var merged = {};
          try { var loc = JSON.parse(localStorage.getItem('smartplan_work_catalog') || '{}'); if (loc && loc.areas) merged = loc.areas; } catch (e) {}
          var cnt = 0;
          results.forEach(function (r) {
            if (r) { merged[r.area] = r.works; cnt += r.works.length; }
          });
          var dbData = { schema: 5, areas: merged };
          try { localStorage.setItem('smartplan_work_catalog', JSON.stringify(dbData)); } catch (e) {}
          if (window.SP_WORK) window.SP_WORK.reloadFromCloud(dbData);
          console.log('  🔧 Виды работ: ' + cnt + ' (участков: ' + Object.keys(merged).length + ')');
        });
      })().catch(function (e) { console.warn('  🔧 Ошибка загрузки работ:', e.message); })
    );

    // Объекты
    promises.push(
      apiGet(EP.objects).then(function(data) {
        if (data && data.objects) {
          // MERGE: сервер приоритетнее, но контур области (poly), описание и цвет
          // не теряем, если на сервере их нет (старые записи до появления poly
          // или импорт KML до обновления бэкенда). Такие объекты «залечиваем» —
          // отправляем обратно на сервер, чтобы контуры сохранились у всех.
          var localObjs = {};
          try {
            var ldb = JSON.parse(localStorage.getItem('smartplan_objects_db') || '{}');
            (ldb.objects || []).forEach(function(o) { if (o && o.id) localObjs[o.id] = o; });
          } catch(e) {}
          var healed = [];
          data.objects.forEach(function(o) {
            var loc = localObjs[o.id];
            if (!loc) return;
            var needHeal = false;
            if (!o.poly && loc.poly && loc.poly.length >= 3) { o.poly = loc.poly; needHeal = true; }
            if ((o.descr == null || o.descr === '') && loc.descr) { o.descr = loc.descr; needHeal = true; }
            if (!o.color && loc.color) { o.color = loc.color; needHeal = true; }
            if (!o.respId && loc.respId) { o.respId = loc.respId; o.respName = loc.respName || ''; needHeal = true; }
            if (needHeal) healed.push(o);
          });
          var dbData = { schema: 2, objects: data.objects };
          try { localStorage.setItem('smartplan_objects_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_OBJECTS) window.SP_OBJECTS.reloadFromCloud(dbData);
          // залечиваем сервер: контуры, которые были только локально
          if (healed.length && CFG.useServerApi && CFG.serverUrl) {
            healed.forEach(function(o) {
              try {
                (window.SP_NET ? SP_NET.send : fetch)(CFG.serverUrl + '/api/objects/' + encodeURIComponent(o.id), {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(o)
                }).catch(function() {});
              } catch(e) {}
            });
            console.log('  📍 Залечено контуров областей: ' + healed.length);
          }
          console.log('  📍 Объекты: ' + data.objects.length);
        }
      }).catch(function(e) { console.warn('  📍 Ошибка загрузки объектов:', e.message); })
    );

    // Работники (время работы, графики, бригады, отсутствия)
    promises.push(
      apiGet('/api/workers').then(function(data) {
        if (data && data.workers) {
          var dbData = { schema: 1, workers: data.workers };
          try { localStorage.setItem('smartplan_workers_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_WORKERS) window.SP_WORKERS.reloadFromCloud(dbData);
          console.log('  👷 Работники: ' + Object.keys(data.workers).length);
        }
      }).catch(function(e) { console.warn('  👷 Ошибка загрузки работников:', e.message); })
    );

    // Задания — MERGE по updated_at (защита от конфликтов вместо слепой замены):
    //  · серверная версия новее локальной → берём серверную (правка другого пользователя);
    //  · локальная новее (своя правка ещё не дошла/сделана офлайн) → сохраняем локальную;
    //  · задачи, созданные офлайн (их нет на сервере) → сохраняем, ЕСЛИ их нет
    //    в серверной корзине (иначе это удаление с другого устройства);
    //  · о полученных от других пользователей изменениях — предупреждение.
    promises.push(
      apiGet(EP.tasks).then(function(data) {
        if (!data || !data.tasks) return;
        return apiGet('/api/trash').catch(function() { return null; }).then(function(trashData) {
          var serverTrashIds = {};
          if (trashData && trashData.tasks) trashData.tasks.forEach(function(t) { if (t && t.id) serverTrashIds[t.id] = 1; });
          var localTasks = window.SP_TASKS ? window.SP_TASKS.getTasks() : [];
          var byId = {};
          localTasks.forEach(function(t) { if (t && t.id) byId[t.id] = t; });
          function sig(t) {
            return JSON.stringify([t.addr, t.o, t.works || [t.w], t.volumes, t.m, t.d, t.dl, t.s || t.status, t.brigade, t.slesari, t.lat, t.lng]);
          }
          var merged = [], seen = {}, updatedByOthers = 0, keptLocal = 0;
          data.tasks.forEach(function(st) {
            if (!st || !st.id) return;
            seen[st.id] = 1;
            var lt = byId[st.id];
            if (lt && lt.updated_at != null && (st.updated_at == null || lt.updated_at > st.updated_at)) {
              merged.push(lt); keptLocal++; // своя правка новее — не даём серверу её затереть
            } else {
              if (lt && st.updated_at != null && (lt.updated_at == null || st.updated_at > lt.updated_at) && sig(lt) !== sig(st)) updatedByOthers++;
              merged.push(st);
            }
          });
          localTasks.forEach(function(t) {
            if (t && t.id && !seen[t.id] && !serverTrashIds[t.id]) merged.push(t); // создана офлайн — сохраняем
          });
          var dbData = { schema: 3, tasks: merged };
          try { localStorage.setItem('smartplan_tasks_db', JSON.stringify(dbData)); } catch(e) {}
          if (window.SP_TASKS) window.SP_TASKS.reloadFromCloud(dbData);
          console.log('  📋 Задания: ' + merged.length + ' (локальных новее сервера: ' + keptLocal + ')');
          if (updatedByOthers > 0 && typeof window.SP_toast === 'function') {
            try { window.SP_toast('warn', '⚠ Другие пользователи изменили задач: ' + updatedByOthers); } catch (e) {}
          }
        });
      }).catch(function(e) { console.warn('  📋 Ошибка загрузки заданий:', e.message); })
    );

    return Promise.all(promises).then(function() {
      console.log('✅ Синхронизация завершена');
      // Синхронизация НИКОГДА не меняет сессию — только данные
      try {
        // Хэш ключевых полей ВСЕХ задач — ловит перемещение, статус, объём
        var allTasks = window.SP_TASKS ? window.SP_TASKS.getTasks() : [];
        var hashParts = allTasks.map(function(t) {
          return t.id + ':' + t.d + ':' + t.m + ':' + (t.s || t.status) + ':' + (t.volume || 1) + ':' + (t.dl || '');
        }).join('|');
        var newHash = hashParts.length + ':' + hashParts;
        var changed = newHash !== lastSyncHash;
        lastSyncHash = newHash;
        if (changed && typeof window.onSyncUpdate === 'function') {
          setTimeout(window.onSyncUpdate, 50);
        }
      } catch(e) {}
    });
  }
  var lastSyncHash = 0;

  // ============================================================
  // ОТПРАВКА ИЗМЕНЕНИЙ НА СЕРВЕР (всегда пытается, без проверки serverOnline)
  // ============================================================

  // Пользователь: создать/обновить
  function sendUser(user) {
    if (!API) return;
    netSend(API + EP.users, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) })
      .then(function() { console.log('✅ Пользователь отправлен на сервер:', user.login); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки пользователя:', e.message); });
  }

  // Пользователь: удалить
  function sendUserDelete(id) {
    if (!API) return;
    netSend(API + EP.users + '/' + id, { method: 'DELETE' })
      .then(function() { console.log('✅ Пользователь удалён на сервере:', id); })
      .catch(function(e) { console.warn('⚠️ Ошибка удаления пользователя:', e.message); });
  }

  // Работа: создать/обновить
  function sendWork(area, work) {
    if (!API) return;
    netSend(API + EP.works + '/' + area, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(work) })
      .then(function() { console.log('✅ Работа отправлена на сервер:', work.name); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки работы:', e.message); });
  }

  // Работа: удалить
  function sendWorkDelete(area, id) {
    if (!API) return;
    netSend(API + EP.works + '/' + area + '/' + id, { method: 'DELETE' })
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
    netSend(API + EP.tasks, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function() { console.log('✅ Задание отправлено на сервер:', task.id); })
      .catch(function(e) { console.warn('⚠️ Ошибка отправки задания:', e.message); });
  }

  // Задание: удалить
  function sendTaskDelete(id) {
    if (!API) return;
    netSend(API + EP.tasks + '/' + id, { method: 'DELETE' })
      .then(function() { console.log('✅ Задание удалено на сервере:', id); })
      .catch(function(e) { console.warn('⚠️ Ошибка удаления задания:', e.message); });
  }

  // Объект: создать/обновить
  function sendObject(obj) {
    if (!API) return;
    netSend(API + EP.objects, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
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
            window.SP_AREAS ? window.SP_AREAS.ensureSeed() : Promise.resolve(),
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
          window.SP_AREAS ? window.SP_AREAS.ensureSeed() : Promise.resolve(),
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
  // СЕССИЯ — только при явном входе (ввод логина/пароля)
  // ============================================================
  var LOGGED_KEY = 'smartplan_logged_in'; // '1' = пользователь сам ввёл пароль

  function getSession() {
    try {
      // Проверяем флаг явного входа — без него сессия не восстанавливается
      var loggedIn = localStorage.getItem(LOGGED_KEY);
      if (loggedIn !== '1') return null;
      var id = localStorage.getItem(SESS_KEY);
      if (!id) return null;
      return window.SP_USERS_DB.getUser(id);
    } catch (e) { return null; }
  }
  function setSession(id) { try { localStorage.setItem(SESS_KEY, id); localStorage.setItem(LOGGED_KEY, '1'); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SESS_KEY); localStorage.removeItem(LOGGED_KEY); } catch (e) {} }

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
