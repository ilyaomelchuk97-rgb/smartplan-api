/* ============================================================
   SmartPlan — Service Worker (PWA: офлайн-режим + установка)
   ------------------------------------------------------------
   Стратегии:
   - ЖИВЫЕ файлы приложения (index.html, app.js, *.js) — сеть
     в приоритете, кэш — офлайн-фолбэк. Обновления app.js
     видны сразу после деплоя, как и без PWA.
   - Неизменяемая статика (fon.webp, logo.png, иконки, xlsx) —
     кэш с фоновой догрузкой (stale-while-revalidate).
   - Всё внешнее (API Render, Яндекс.Карты, Open-Meteo, CDN) —
     мимо service worker'а.
   Данные приложения живут в localStorage — доступны офлайн.
   ============================================================ */
var CACHE = 'smartplan-v4-root';

// Файлы, которые всегда пытаются загрузиться с сети (обновляемые)
var FRESH = [
  './', './index.html', './root_index/app.js', './root_index/config.js', './root_index/data.js',
  './root_index/users_db.js', './root_index/areas_db.js', './root_index/work_db.js', './root_index/objects_db.js',
  './root_index/workers_db.js', './root_index/tasks_db.js', './root_index/db.js'
];
// Предзагрузка при установке (чтобы офлайн-режим работал сразу)
var PRECACHE = FRESH.concat(['./root_index/logo.png', './root_index/fon.webp', './root_index/icon-192.png', './root_index/manifest.json']);

// Сравнение пути запроса с элементом списка FRESH: url.pathname всегда
// начинается с «/» («/app.js»), а в списке — «./app.js». Раньше сравнение
// шло впрямую и НИКОГДА не совпадало — app.js обслуживался из кэша
// (обновления деплоя не были видны без повторной перезагрузки).
function isFreshPath(pathname) {
  for (var i = 0; i < FRESH.length; i++) {
    var f = FRESH[i];
    if (f === pathname) return true;
    if (f.slice(0, 2) === './' && f.slice(1) === pathname) return true; // './root_index/app.js' ↔ '/app.js'
    if (f === './' && pathname === '/') return true;
  }
  return false;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // addAll целиком падает, если хоть один файл недоступен — грузим по одному
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return; // внешние запросы — мимо SW

  var fresh = isFreshPath(url.pathname);
  if (fresh) {
    // Сеть в приоритете; параллельно обновляем кэш; офлайн — кэш/ index.html
    e.respondWith(
      fetch(req).then(function (r) {
        try { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); } catch (err) {}
        return r;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match('./index.html'); });
      })
    );
    return;
  }
  // Прочая статика (картинки, xlsx, drive3d.html…) — кэш с фоновой догрузкой
  e.respondWith(
    caches.match(req).then(function (m) {
      var net = fetch(req).then(function (r) {
        if (r && r.ok) {
          try { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); } catch (err) {}
        }
        return r;
      }).catch(function () { return m; });
      return m || net;
    })
  );
});
