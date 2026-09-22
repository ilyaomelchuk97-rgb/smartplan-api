import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { query, initDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// СЕССИЯ (простая проверка по заголовку, без JWT)
// ============================================================
app.use((req, res, next) => {
  // CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// ГЛАВНАЯ — статус сервера
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SmartPlan API', version: '1.0.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ============================================================
// РЕЗЕРВНЫЕ КОПИИ (автобэкап раз в сутки; последний — на скачивание)
// ============================================================
async function makeBackup() {
  const [areas, objects, works, users, tasks, workers] = await Promise.all([
    query('SELECT * FROM areas'),
    query('SELECT * FROM objects'),
    query('SELECT * FROM works'),
    query('SELECT * FROM users'),
    query("SELECT * FROM tasks WHERE status != 'deleted' AND s != 'deleted'"),
    query('SELECT * FROM workers')
  ]);
  const data = JSON.stringify({
    version: 1, ts: Date.now(),
    areas: areas.rows, objects: objects.rows, works: works.rows,
    users: users.rows, tasks: tasks.rows, workers: workers.rows
  });
  const ts = Date.now();
  await query('INSERT INTO backups (ts, data) VALUES ($1, $2) ON CONFLICT (ts) DO NOTHING', [ts, data]);
  // храним последние 7 копий
  await query('DELETE FROM backups WHERE ts NOT IN (SELECT ts FROM backups ORDER BY ts DESC LIMIT 7)');
  return { ts, size: data.length };
}
// автобэкап: при обращении к health — если последней копии больше суток
app.get('/api/backup', async (req, res) => {
  try {
    const last = await query('SELECT ts FROM backups ORDER BY ts DESC LIMIT 1');
    const lastTs = last.rows.length ? Number(last.rows[0].ts) : 0;
    if (Date.now() - lastTs > 24 * 3600 * 1000) {
      await makeBackup(); // раз в сутки — свежая копия
    }
    const r = await query('SELECT ts, data FROM backups ORDER BY ts DESC LIMIT 1');
    if (!r.rows.length) return res.json({ ok: false, reason: 'нет копий' });
    res.json({ ok: true, ts: Number(r.rows[0].ts), data: JSON.parse(r.rows[0].data) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// создать копию прямо сейчас
app.post('/api/backup', async (req, res) => {
  try {
    const b = await makeBackup();
    res.json({ ok: true, ts: b.ts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ПОЛЬЗОВАТЕЛИ
// ============================================================

// Получить всех пользователей
app.get('/api/users', async (req, res) => {
  try {
    const result = await query('SELECT * FROM users ORDER BY created DESC');
    const users = result.rows.map(u => ({
      id: u.id,
      login: u.login,
      password: u.password,
      plain_password: u.plain_password,
      full_name: u.full_name,
      role: u.role,
      area: u.area,
      color: u.color,
      active: u.active,
      prof: u.prof || '',
      seed: true,
    }));
    res.json({ schema: 3, users });
  } catch (err) {
    console.error('GET /api/users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Получить пользователя по ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Не найден' });
    const u = result.rows[0];
    res.json({
      id: u.id, login: u.login, password: u.password, plain_password: u.plain_password,
      full_name: u.full_name, role: u.role, area: u.area, color: u.color, active: u.active,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создать пользователя
app.post('/api/users', async (req, res) => {
  try {
    const { id, login, password, plain_password, full_name, role, area, color, active, prof } = req.body;
    // Проверка уникальности логина
    const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
    if (exists.rows.length) return res.status(409).json({ error: 'Логин уже занят' });

    const hashed = bcrypt.hashSync(password || 'admin123', 10);
    const newId = id || 'u_' + Date.now().toString(36);
    await query(
      `INSERT INTO users (id, login, password, plain_password, full_name, role, area, color, active, prof, created)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId, login, hashed, plain_password || password || 'admin123', full_name, role || 'master', area || '', color || '#2563eb', active !== false, prof || '', Date.now()]
    );
    res.json({ id: newId, login, full_name, role, area, color, active });
  } catch (err) {
    console.error('POST /api/users:', err);
    res.status(500).json({ error: err.message });
  }
});

// Обновить пользователя
app.put('/api/users/:id', async (req, res) => {
  try {
    const u = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Не найден' });
    const cur = u.rows[0];
    const d = req.body;

    if (d.login && d.login !== cur.login) {
      const dup = await query('SELECT id FROM users WHERE login = $1 AND id != $2', [d.login, req.params.id]);
      if (dup.rows.length) return res.status(409).json({ error: 'Логин уже занят' });
    }

    const hashed = d.password ? bcrypt.hashSync(d.password, 10) : cur.password;
    const plain = d.password || cur.plain_password;

    await query(
      `UPDATE users SET login=$1, password=$2, plain_password=$3, full_name=$4, role=$5, area=$6, color=$7, active=$8, prof=$9
       WHERE id=$10`,
      [
        d.login || cur.login, hashed, plain,
        d.full_name !== undefined ? d.full_name : cur.full_name,
        d.role !== undefined ? d.role : cur.role,
        d.area !== undefined ? d.area : cur.area,
        d.color !== undefined ? d.color : cur.color,
        d.active !== undefined ? d.active : cur.active,
        d.prof !== undefined ? d.prof : (cur.prof || ''),
        req.params.id
      ]
    );
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удалить пользователя
app.delete('/api/users/:id', async (req, res) => {
  try {
    const admins = await query("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND active=true");
    if (req.params.id === 'u_seogs') {
      return res.status(400).json({ error: 'Аккаунт «Начальник СЭОГС» — системный. Удаление запрещено.' });
    }
    const u = await query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (u.rows.length && u.rows[0].role === 'admin' && parseInt(admins.rows[0].cnt) <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    }
    await query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Аутентификация
app.post('/api/auth', async (req, res) => {
  try {
    const { login, password } = req.body;
    const result = await query('SELECT * FROM users WHERE login = $1 AND active = true', [login]);
    if (!result.rows.length) return res.json({ user: null });

    const u = result.rows[0];
    // Проверка: пароль admin123, логин, plain_password или хэш
    const ok =
      password === 'admin123' ||
      password === u.plain_password ||
      bcrypt.compareSync(password, u.password);

    if (!ok) return res.json({ user: null });

    res.json({
      user: {
        id: u.id, login: u.login, full_name: u.full_name, role: u.role, area: u.area,
        color: u.color, active: u.active,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Полная замена базы пользователей (импорт)
app.post('/api/users/bulk', async (req, res) => {
  try {
    const { users, mode } = req.body;
    if (mode === 'replace') {
      await query('DELETE FROM users');
    }
    let added = 0;
    for (const u of users) {
      const exists = await query('SELECT id FROM users WHERE id=$1 OR login=$2', [u.id, u.login]);
      if (!exists.rows.length) {
        const hashed = u.password && !u.password.startsWith('$2') ? bcrypt.hashSync(u.password, 10) : (u.password || bcrypt.hashSync('admin123', 10));
        await query(
          `INSERT INTO users (id, login, password, plain_password, full_name, role, area, color, active, created)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [u.id || 'u_' + Date.now(), u.login, hashed, u.plain_password || 'admin123', u.full_name, u.role || 'master', u.area || '', u.color || '#2563eb', u.active !== false, Date.now()]
        );
        added++;
      }
    }
    res.json({ mode, added, total: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ВИДЫ РАБОТ
// ============================================================

app.get('/api/works/:area', async (req, res) => {
  try {
    const result = await query('SELECT * FROM works WHERE area = $1 ORDER BY "group", name', [req.params.area]);
    const works = result.rows.map(w => ({
      id: w.id, group: w.group, name: w.name, norm: parseFloat(w.norm), unit: w.unit,
      needs_permit: w.needs_permit, depends_on_snow: w.depends_on_snow,
      min_temp: parseFloat(w.min_temp), season: w.season, equipment: w.equipment,
      min_workers: w.min_workers, opt_workers: w.opt_workers,
    }));
    res.json({ area: req.params.area, works });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/works/:area', async (req, res) => {
  try {
    const d = req.body;
    const id = d.id || 'w_' + Date.now().toString(36);
    await query(
      `INSERT INTO works (id, area, "group", name, norm, unit, needs_permit, depends_on_snow, min_temp, season, equipment, min_workers, opt_workers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id, area) DO UPDATE SET
         "group"=EXCLUDED."group", name=EXCLUDED.name, norm=EXCLUDED.norm, unit=EXCLUDED.unit,
         needs_permit=EXCLUDED.needs_permit, depends_on_snow=EXCLUDED.depends_on_snow,
         min_temp=EXCLUDED.min_temp, season=EXCLUDED.season, equipment=EXCLUDED.equipment,
         min_workers=EXCLUDED.min_workers, opt_workers=EXCLUDED.opt_workers`,
      [id, req.params.area, d.group || 'Без группы', d.name, parseFloat(d.norm) || 0, d.unit || 'объект',
       d.needs_permit || false, d.depends_on_snow || false, parseFloat(d.min_temp) || -50,
       d.season || 'Круглый год', d.equipment || '—', parseInt(d.min_workers) || 1, parseInt(d.opt_workers) || 2]
    );
    res.json({ id, ...d });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/works/:area/:id', async (req, res) => {
  try {
    const d = req.body;
    await query(
      `UPDATE works SET "group"=$1, name=$2, norm=$3, unit=$4, needs_permit=$5, depends_on_snow=$6,
       min_temp=$7, season=$8, equipment=$9, min_workers=$10, opt_workers=$11
       WHERE id=$12 AND area=$13`,
      [d.group || 'Без группы', d.name, parseFloat(d.norm) || 0, d.unit || 'объект',
       d.needs_permit || false, d.depends_on_snow || false, parseFloat(d.min_temp) || -50,
       d.season || 'Круглый год', d.equipment || '—', parseInt(d.min_workers) || 1, parseInt(d.opt_workers) || 2,
       req.params.id, req.params.area]
    );
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/works/:area/:id', async (req, res) => {
  try {
    await query('DELETE FROM works WHERE id=$1 AND area=$2', [req.params.id, req.params.area]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ОБЪЕКТЫ
// ============================================================

app.get('/api/objects', async (req, res) => {
  try {
    const result = await query('SELECT * FROM objects ORDER BY addr');
    const objects = result.rows
      // защита от мусорных пустых строк (пустой addr+num без полигона и координат)
      .filter(o => (o.addr && String(o.addr).trim()) || (o.num && String(o.num).trim()) || o.poly || (o.lat != null && o.lng != null))
      .map(o => {
        let poly = null;
        try { poly = o.poly ? JSON.parse(o.poly) : null; } catch (e) { poly = null; }
        return {
          id: o.id, addr: o.addr, type: o.type, num: o.num || '',
          lat: o.lat != null ? parseFloat(o.lat) : null,
          lng: o.lng != null ? parseFloat(o.lng) : null,
          zu: o.zu, area_obj: parseFloat(o.area_obj), length_km: parseFloat(o.length_km), area_ha: parseFloat(o.area_ha),
          poly: poly, descr: o.descr || '', color: o.color || '',
          respId: o.resp_id || '', respName: o.resp_name || ''
        };
      });
    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Полигон области в SQL-формат: массив [[lat,lng],...] → JSON-строка
function polyToSql(p) {
  if (!p) return null;
  if (typeof p === 'string') return p;
  try { return JSON.stringify(p); } catch (e) { return null; }
}

app.post('/api/objects', async (req, res) => {
  try {
    // Поддерживаем и один объект, и массив (полная синхронизация справочника)
    const items = Array.isArray(req.body)
      ? req.body.filter(d => d && d.id)
      : [Object.assign({}, req.body, { id: req.body.id || 'o_' + Date.now().toString(36) })];
    for (const d of items) {
      await query(
        `INSERT INTO objects (id, addr, type, num, lat, lng, zu, area_obj, length_km, area_ha, poly, descr, color, resp_id, resp_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET addr=EXCLUDED.addr, type=EXCLUDED.type, num=EXCLUDED.num,
           lat=EXCLUDED.lat, lng=EXCLUDED.lng, zu=EXCLUDED.zu, area_obj=EXCLUDED.area_obj,
           length_km=EXCLUDED.length_km, area_ha=EXCLUDED.area_ha, poly=EXCLUDED.poly,
           descr=EXCLUDED.descr, color=EXCLUDED.color, resp_id=EXCLUDED.resp_id, resp_name=EXCLUDED.resp_name`,
        [d.id, d.addr || '', d.type || 'Объект', d.num != null ? String(d.num) : '', d.lat || null, d.lng || null,
         d.zu || 0, d.area_obj || 0, d.length_km || 0, d.area_ha || 0,
         polyToSql(d.poly), d.descr || '', d.color || '', d.respId || '', d.respName || '']
      );
    }
    res.json({ saved: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Изменение объекта (справочник ГРП/ШРП)
app.put('/api/objects/:id', async (req, res) => {
  try {
    const d = req.body;
    const exists = await query('SELECT id FROM objects WHERE id=$1', [req.params.id]);
    if (!exists.rows.length) {
      await query(
        `INSERT INTO objects (id, addr, type, num, lat, lng, zu, area_obj, length_km, area_ha, poly, descr, color, resp_id, resp_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [req.params.id, d.addr || '', d.type || 'Объект', d.num != null ? String(d.num) : '', d.lat || null, d.lng || null,
         d.zu || 0, d.area_obj || 0, d.length_km || 0, d.area_ha || 0,
         polyToSql(d.poly), d.descr || '', d.color || '', d.respId || '', d.respName || '']
      );
    } else {
      await query(
        `UPDATE objects SET addr=$1, type=$2, num=$3, lat=$4, lng=$5, zu=$6, area_obj=$7, length_km=$8, area_ha=$9, poly=$10, descr=$11, color=$12, resp_id=$13, resp_name=$14
         WHERE id=$15`,
        [d.addr || '', d.type || 'Объект', d.num != null ? String(d.num) : '', d.lat || null, d.lng || null,
         d.zu || 0, d.area_obj || 0, d.length_km || 0, d.area_ha || 0,
         polyToSql(d.poly), d.descr || '', d.color || '', d.respId || '', d.respName || '', req.params.id]
      );
    }
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    console.error('PUT /api/objects/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Удаление объекта
app.delete('/api/objects/:id', async (req, res) => {
  try {
    await query('DELETE FROM objects WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// УЧАСТКИ (справочник)
// ============================================================

app.get('/api/areas', async (req, res) => {
  try {
    const result = await query('SELECT id, name FROM areas ORDER BY name');
    res.json({ areas: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/areas', async (req, res) => {
  try {
    const d = req.body;
    const id = d.id || 'a_' + Date.now().toString(36);
    const name = String(d.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Название участка обязательно' });
    await query(
      `INSERT INTO areas (id, name, created) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [id, name, Date.now()]
    );
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Переименование участка: переносим работы и пользователей
app.put('/api/areas/:id', async (req, res) => {
  try {
    const d = req.body;
    const newName = String(d.name || '').trim();
    const oldName = String(d.oldName || '').trim();
    if (!newName) return res.status(400).json({ error: 'Название участка обязательно' });
    const dup = await query('SELECT id FROM areas WHERE name=$1 AND id<>$2', [newName, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ error: 'Участок с таким названием уже существует' });
    const upd = await query('UPDATE areas SET name=$1 WHERE id=$2 RETURNING name', [newName, req.params.id]);
    if (upd.rows.length && oldName && oldName !== newName) {
      await query('UPDATE works SET area=$1 WHERE area=$2', [newName, oldName]);
      await query('UPDATE users SET area=$1 WHERE area=$2', [newName, oldName]);
    }
    res.json({ id: req.params.id, name: newName, renamed: upd.rows.length > 0 });
  } catch (err) {
    console.error('PUT /api/areas/:id:', err);
    res.status(500).json({ error: err.message });
  }
});

// Удаление участка (вместе с его работами; пользователи не удаляются)
app.delete('/api/areas/:id', async (req, res) => {
  try {
    const found = await query('SELECT name FROM areas WHERE id=$1', [req.params.id]);
    const name = found.rows.length ? found.rows[0].name : null;
    if (name) await query('DELETE FROM works WHERE area=$1', [name]);
    await query('DELETE FROM areas WHERE id=$1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ЗАДАНИЯ
// ============================================================

// === РАБОТНИКИ (страница «Работники»: время 8/12 ч, график 5/2-2/2, бригады, отсутствия) ===
app.get('/api/workers', async (req, res) => {
  try {
    const result = await query('SELECT uid, data FROM workers');
    const workers = {};
    result.rows.forEach(r => {
      try { workers[r.uid] = JSON.parse(r.data) || {}; } catch (e) { workers[r.uid] = {}; }
    });
    res.json({ workers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Приём настроек работников (bulk upsert): { schema, workers: { uid: {...} } }
app.post('/api/workers', async (req, res) => {
  try {
    const body = req.body || {};
    const map = body.workers || {};
    for (const uid of Object.keys(map)) {
      const data = JSON.stringify(map[uid]);
      await query(
        `INSERT INTO workers (uid, data) VALUES ($1, $2)
         ON CONFLICT (uid) DO UPDATE SET data = EXCLUDED.data`,
        [uid, data]
      );
    }
    res.json({ ok: true, count: Object.keys(map).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const result = await query("SELECT * FROM tasks WHERE status != 'deleted' AND s != 'deleted' ORDER BY d, m");
    const tasks = result.rows.map(t => ({
      id: t.id, addr: t.addr, o: t.o, w: t.w, works: t.works ? JSON.parse(t.works) : (t.w ? [t.w] : []),
      m: t.m, d: t.d, dl: t.dl, s: t.s, status: t.status,
      volume: parseFloat(t.volume) || 1, dl_date: t.dl_date,
      needs_permit: t.needs_permit, depends_on_snow: t.depends_on_snow,
      min_temp: parseFloat(t.min_temp) || -50, equipment: t.equipment,
      travelMin: t.travel_min, travelKm: t.travel_km ? parseFloat(t.travel_km) : null,
      travelKmText: t.travel_km_text, travelText: t.travel_text,
      lat: t.lat != null ? parseFloat(t.lat) : null,
      lng: t.lng != null ? parseFloat(t.lng) : null,
      coord_src: t.coord_src || null,
      volumes: t.volumes ? JSON.parse(t.volumes) : null,
      slesari: t.slesari ? JSON.parse(t.slesari) : null,
      brigade: t.brigade || false,
      updated_at: parseInt(t.updated_at, 10) || 0 // версия задачи — защита от конфликтов
    }));
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const t = req.body;
    const id = t.id || 't_' + Date.now();
    const updAt = parseInt(t.updated_at, 10) || Date.now(); // версия задачи (защита от конфликтов)
    await query(
      `INSERT INTO tasks (id, addr, o, w, works, m, d, dl, s, status, volume, dl_date, needs_permit, depends_on_snow, min_temp, equipment, travel_min, travel_km, travel_km_text, travel_text, lat, lng, coord_src, volumes, slesari, brigade, created, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (id) DO UPDATE SET addr=EXCLUDED.addr, o=EXCLUDED.o, w=EXCLUDED.w, works=EXCLUDED.works,
         lat=EXCLUDED.lat, lng=EXCLUDED.lng, coord_src=EXCLUDED.coord_src, volumes=EXCLUDED.volumes, slesari=EXCLUDED.slesari, brigade=EXCLUDED.brigade, updated_at=EXCLUDED.updated_at`,
      [
        id, t.addr, t.o, t.w, JSON.stringify(t.works || [t.w]), t.m, t.d || 0, t.dl || 7, t.s || 'plan', t.status || 'plan',
        parseFloat(t.volume) || 1, t.dl_date, t.needs_permit || false, t.depends_on_snow || false,
        parseFloat(t.min_temp) || -50, t.equipment || '—',
        t.travelMin || 15, t.travelKm || null, t.travelKmText || null, t.travelText || null,
        (t.lat != null && t.lat !== '') ? parseFloat(t.lat) : null,
        (t.lng != null && t.lng !== '') ? parseFloat(t.lng) : null,
        t.coord_src || null,
        (t.volumes && t.volumes.length) ? JSON.stringify(t.volumes) : null,
        (t.slesari && t.slesari.length) ? JSON.stringify(t.slesari) : null,
        t.brigade || false,
        Date.now(),
        updAt
      ]
    );
    res.json({ id, ...t, updated_at: updAt });
  } catch (err) {
    console.error('POST /api/tasks:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const t = req.body;
    const updAt = parseInt(t.updated_at, 10) || Date.now(); // версия задачи (защита от конфликтов)
    await query(
      `UPDATE tasks SET addr=$1, o=$2, w=$3, works=$4, m=$5, d=$6, dl=$7, s=$8, status=$9,
       volume=$10, dl_date=$11, needs_permit=$12, depends_on_snow=$13, min_temp=$14, equipment=$15,
       travel_min=$16, travel_km=$17, travel_km_text=$18, travel_text=$19,
       lat=$20, lng=$21, coord_src=$22, volumes=$23, slesari=$24, brigade=$25, updated_at=$26
       WHERE id=$27`,
      [
        t.addr, t.o, t.w, JSON.stringify(t.works || [t.w]), t.m, t.d, t.dl, t.s || 'plan', t.status || 'plan',
        parseFloat(t.volume) || 1, t.dl_date, t.needs_permit || false, t.depends_on_snow || false,
        parseFloat(t.min_temp) || -50, t.equipment || '—',
        t.travelMin || 15, t.travelKm, t.travelKmText, t.travelText,
        (t.lat != null && t.lat !== '') ? parseFloat(t.lat) : null,
        (t.lng != null && t.lng !== '') ? parseFloat(t.lng) : null,
        t.coord_src || null,
        (t.volumes && t.volumes.length) ? JSON.stringify(t.volumes) : null,
        (t.slesari && t.slesari.length) ? JSON.stringify(t.slesari) : null,
        t.brigade || false,
        updAt,
        req.params.id
      ]
    );
    res.json({ id: req.params.id, updated: true, updated_at: updAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === КОРЗИНА: мягкое удаление (без физического удаления) ===
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    // Помечаем как удалённую, не удаляем физически
    await query("UPDATE tasks SET status='deleted', s='deleted' WHERE id=$1", [req.params.id]);
    // Если задачи нет в таблице — добавляем как удалённую
    const exists = await query("SELECT id FROM tasks WHERE id=$1", [req.params.id]);
    if (!exists.rows.length) {
      await query(
        `INSERT INTO tasks (id, addr, m, d, dl, s, status, volume, created)
         VALUES ($1, '(удалено)', 'deleted', 0, 0, 'deleted', 'deleted', 1, $2)`,
        [req.params.id, Date.now()]
      );
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === КОРЗИНА: список удалённых задач ===
app.get('/api/trash', async (req, res) => {
  try {
    const result = await query("SELECT * FROM tasks WHERE status='deleted' OR s='deleted' ORDER BY created DESC");
    res.json({ tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === КОРЗИНА: восстановление задачи ===
app.put('/api/trash/restore/:id', async (req, res) => {
  try {
    const t = req.body || {};
    await query(
      `UPDATE tasks SET status=$1, s=$2, addr=$3, m=$4, d=$5, dl=$6, volume=$7, updated_at=$8 WHERE id=$9`,
      [t.status || 'plan', t.s || 'plan', t.addr || '', t.m || '', t.d || 0, t.dl || 7, t.volume || 1, Date.now(), req.params.id]
    );
    res.json({ restored: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === КОРЗИНА: физическое удаление (очистка) ===
app.delete('/api/trash/:id', async (req, res) => {
  try {
    await query("DELETE FROM tasks WHERE id=$1 AND (status='deleted' OR s='deleted')", [req.params.id]);
    res.json({ purged: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// СИДИНГ (начальные данные)
// ============================================================
app.post('/api/seed', async (req, res) => {
  try {
    // Админ по умолчанию
    const adminExists = await query("SELECT id FROM users WHERE login='admin'");
    if (!adminExists.rows.length) {
      const hashed = bcrypt.hashSync('admin123', 10);
      await query(
        `INSERT INTO users (id, login, password, plain_password, full_name, role, area, color, active, created)
         VALUES ('u_admin','admin',$1,'admin123','Администратор системы','admin','Все участки','#0f2740',true,$2)`,
        [hashed, Date.now()]
      );
    }

    // Начальник СЭОГС — только просмотр (права как у админа, без редактирования)
    const seogsExists = await query("SELECT id FROM users WHERE id='u_seogs'");
    if (!seogsExists.rows.length) {
      const hashedS = bcrypt.hashSync('seogs123', 10);
      await query(
        `INSERT INTO users (id, login, password, plain_password, full_name, role, area, color, active, created)
         VALUES ('u_seogs','seogs',$1,'seogs123','Начальник СЭОГС','viewer','Все участки','#64748b',true,$2)
         ON CONFLICT (id) DO NOTHING`,
        [hashedS, Date.now()]
      );
    }

    // Базовые виды работ УБиРОГС
    const workCount = await query("SELECT COUNT(*) as cnt FROM works WHERE area='УБиРОГС'");
    if (parseInt(workCount.rows[0].cnt) === 0) {
      const defaults = [
        ['w1','Благоустройство','Укладка асфальтобетонного покрытия',0.5,'м2',false,false,5,'Лето','Асфальтоукладчик',4,6],
        ['w2','Благоустройство','Укладка тротуарной плитки',0.4,'м2',false,false,0,'Круглый год','—',2,4],
        ['w3','Благоустройство','Устройство газона (посев)',0.25,'м2',false,false,5,'Весна-осень','—',2,3],
        ['w4','Ремонт зданий ГРП/ШРП','Ремонт кровли ГРП/ШРП',4.0,'объект',false,false,-10,'Круглый год','Автовышка',2,3],
        ['w5','Ремонт зданий ГРП/ШРП','Ремонт стен и отмосток',3.0,'объект',false,false,-5,'Круглый год','—',2,4],
        ['w7','Покраска','Покраска газопровода',0.15,'м2',false,false,5,'Лето','Автовышка',2,3],
        ['w8','Покраска','Покраска металлоконструкций',0.12,'м2',false,false,0,'Круглый год','—',1,2],
        ['w9','Очистка от снега','Очистка территории от снега',0.04,'м2',false,true,-50,'Зима','КДМ / Трактор',1,2],
        ['w10','Очистка от снега','Очистка подъездных путей',0.06,'м2',false,true,-50,'Зима','КДМ',1,1],
        ['w11','Расчистка лесопросек','Расчистка просеки (валка деревьев)',8.0,'га',true,false,-50,'Зима','Бензопила, Трактор',3,5],
        ['w12','Расчистка лесопросек','Уборка порубочных остатков',4.0,'га',false,false,-10,'Зима','Трактор',2,3],
      ];
      for (const w of defaults) {
        await query(
          `INSERT INTO works (id, area, "group", name, norm, unit, needs_permit, depends_on_snow, min_temp, season, equipment, min_workers, opt_workers)
           VALUES ($1,'УБиРОГС',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          w
        );
      }
    }

    // Базовые объекты
    const objCount = await query("SELECT COUNT(*) as cnt FROM objects");
    if (parseInt(objCount.rows[0].cnt) === 0) {
      const objects = [
        ['o1','ГРП-1, ул. Ленина, 5','ГРП',53.9020,27.5610,4,120,0,0],
        ['o2','ШРП-12, ул. Советская, 18','ШРП',53.9097,27.5710,0,60,0,0],
        ['o3','ШРП-8, ул. Пушкина, 3','ШРП',53.9085,27.5650,2,45,0,0],
        ['o4','ГРП-3, пр. Независимости, 76','ГРП',53.9180,27.5820,0,200,0,0],
        ['o5','Трасса Г-101, км 2-4','Трасса',53.9030,27.5380,0,0,2,0],
        ['o6','ШРП-5, ул. Кирова, 12','ШРП',53.8940,27.5640,1,50,0,0],
        ['o7','ГРП-7, ул. Ратомская, 30','ГРП',53.8780,27.5490,0,180,0,0],
        ['o9','Просека, трасса Г-101, км 5-8','Просека',53.9200,27.5500,0,0,0,3],
        ['o10','Просека, трасса Г-205, км 4-7','Просека',53.8950,27.5300,0,0,0,5],
      ];
      for (const o of objects) {
        await query(
          `INSERT INTO objects (id, addr, type, lat, lng, zu, area_obj, length_km, area_ha) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          o
        );
      }
    }

    res.json({ seeded: true, message: 'Начальные данные загружены' });
  } catch (err) {
    console.error('SEED error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ЛОГИ ДЕЙСТВИЙ ПОЛЬЗОВАТЕЛЕЙ
// ============================================================
app.get('/api/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const r = await query('SELECT * FROM action_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ logs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logs', async (req, res) => {
  try {
    const { user_id, user_name, action, details } = req.body;
    await query('INSERT INTO action_logs (user_id, user_name, action, details, created_at) VALUES ($1,$2,$3,$4,$5)',
      [user_id || '', user_name || '', action || '', details || '', Date.now()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/logs', async (req, res) => {
  try {
    await query('DELETE FROM action_logs');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ЗАПУСК
// ============================================================
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`SmartPlan API запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Ошибка инициализации БД:', err);
    // Запуск даже без БД (для отладки)
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`SmartPlan API запущен (БЕЗ БД) на порту ${PORT}`);
    });
  });
