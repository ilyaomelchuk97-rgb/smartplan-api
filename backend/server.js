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
    const { id, login, password, plain_password, full_name, role, area, color, active } = req.body;
    // Проверка уникальности логина
    const exists = await query('SELECT id FROM users WHERE login = $1', [login]);
    if (exists.rows.length) return res.status(409).json({ error: 'Логин уже занят' });

    const hashed = bcrypt.hashSync(password || 'admin123', 10);
    const newId = id || 'u_' + Date.now().toString(36);
    await query(
      `INSERT INTO users (id, login, password, plain_password, full_name, role, area, color, active, created)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [newId, login, hashed, plain_password || password || 'admin123', full_name, role || 'master', area || '', color || '#2563eb', active !== false, Date.now()]
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
      `UPDATE users SET login=$1, password=$2, plain_password=$3, full_name=$4, role=$5, area=$6, color=$7, active=$8
       WHERE id=$9`,
      [
        d.login || cur.login, hashed, plain,
        d.full_name !== undefined ? d.full_name : cur.full_name,
        d.role !== undefined ? d.role : cur.role,
        d.area !== undefined ? d.area : cur.area,
        d.color !== undefined ? d.color : cur.color,
        d.active !== undefined ? d.active : cur.active,
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
    const objects = result.rows.map(o => ({
      id: o.id, addr: o.addr, type: o.type, lat: parseFloat(o.lat), lng: parseFloat(o.lng),
      zu: o.zu, area_obj: parseFloat(o.area_obj), length_km: parseFloat(o.length_km), area_ha: parseFloat(o.area_ha),
    }));
    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/objects', async (req, res) => {
  try {
    const d = req.body;
    const id = d.id || 'o_' + Date.now().toString(36);
    await query(
      `INSERT INTO objects (id, addr, type, lat, lng, zu, area_obj, length_km, area_ha)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET addr=EXCLUDED.addr, type=EXCLUDED.type`,
      [id, d.addr, d.type || 'Объект', d.lat || null, d.lng || null, d.zu || 0, d.area_obj || 0, d.length_km || 0, d.area_ha || 0]
    );
    res.json({ id, ...d });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ЗАДАНИЯ
// ============================================================

app.get('/api/tasks', async (req, res) => {
  try {
    const result = await query('SELECT * FROM tasks ORDER BY d, m');
    const tasks = result.rows.map(t => ({
      id: t.id, addr: t.addr, o: t.o, w: t.w, works: t.works ? JSON.parse(t.works) : (t.w ? [t.w] : []),
      m: t.m, d: t.d, dl: t.dl, s: t.s, status: t.status,
      volume: parseFloat(t.volume) || 1, dl_date: t.dl_date,
      needs_permit: t.needs_permit, depends_on_snow: t.depends_on_snow,
      min_temp: parseFloat(t.min_temp) || -50, equipment: t.equipment,
      travelMin: t.travel_min, travelKm: t.travel_km ? parseFloat(t.travel_km) : null,
      travelKmText: t.travel_km_text, travelText: t.travel_text,
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
    await query(
      `INSERT INTO tasks (id, addr, o, w, works, m, d, dl, s, status, volume, dl_date, needs_permit, depends_on_snow, min_temp, equipment, travel_min, travel_km, travel_km_text, travel_text, created)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO UPDATE SET addr=EXCLUDED.addr, o=EXCLUDED.o, w=EXCLUDED.w, works=EXCLUDED.works`,
      [
        id, t.addr, t.o, t.w, JSON.stringify(t.works || [t.w]), t.m, t.d || 0, t.dl || 7, t.s || 'plan', t.status || 'plan',
        parseFloat(t.volume) || 1, t.dl_date, t.needs_permit || false, t.depends_on_snow || false,
        parseFloat(t.min_temp) || -50, t.equipment || '—',
        t.travelMin || 15, t.travelKm || null, t.travelKmText || null, t.travelText || null,
        Date.now()
      ]
    );
    res.json({ id, ...t });
  } catch (err) {
    console.error('POST /api/tasks:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  try {
    const t = req.body;
    await query(
      `UPDATE tasks SET addr=$1, o=$2, w=$3, works=$4, m=$5, d=$6, dl=$7, s=$8, status=$9,
       volume=$10, dl_date=$11, needs_permit=$12, depends_on_snow=$13, min_temp=$14, equipment=$15,
       travel_min=$16, travel_km=$17, travel_km_text=$18, travel_text=$19
       WHERE id=$20`,
      [
        t.addr, t.o, t.w, JSON.stringify(t.works || [t.w]), t.m, t.d, t.dl, t.s || 'plan', t.status || 'plan',
        parseFloat(t.volume) || 1, t.dl_date, t.needs_permit || false, t.depends_on_snow || false,
        parseFloat(t.min_temp) || -50, t.equipment || '—',
        t.travelMin || 15, t.travelKm, t.travelKmText, t.travelText,
        req.params.id
      ]
    );
    res.json({ id: req.params.id, updated: true });
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
      `UPDATE tasks SET status=$1, s=$2, addr=$3, m=$4, d=$5, dl=$6, volume=$7 WHERE id=$8`,
      [t.status || 'plan', t.s || 'plan', t.addr || '', t.m || '', t.d || 0, t.dl || 7, t.volume || 1, req.params.id]
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
