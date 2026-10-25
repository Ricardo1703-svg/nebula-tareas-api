'use strict';
// App 2 - API RESTful de tareas (Express + PostgreSQL), desplegada en Treevoxa.
const os = require('os');
const path = require('path');
const express = require('express');
const { pool, migrate } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ESTADOS = ['pendiente', 'en_progreso', 'completada'];
const CAMPOS = ['titulo', 'descripcion', 'estado', 'prioridad', 'vence_el'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

class ApiError extends Error {
  constructor(status, message, detalles) { super(message); this.status = status; this.detalles = detalles; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new ApiError(400, 'El id debe ser un entero positivo');
  return id;
}

// Valida el cuerpo; con parcial=true (PATCH) solo exige los campos presentes.
function validar(body, parcial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Se espera un objeto JSON');
  const errores = [];
  const out = {};
  const desconocidos = Object.keys(body).filter((k) => !CAMPOS.includes(k));
  if (desconocidos.length) errores.push('Campos no permitidos: ' + desconocidos.join(', '));

  if (!parcial || 'titulo' in body) {
    const t = typeof body.titulo === 'string' ? body.titulo.trim() : '';
    if (!t || t.length > 160) errores.push('titulo es obligatorio (texto de 1 a 160 caracteres)');
    out.titulo = t;
  }
  if ('descripcion' in body || !parcial) {
    const d = body.descripcion;
    if (d != null && (typeof d !== 'string' || d.length > 2000)) errores.push('descripcion debe ser texto de hasta 2000 caracteres o null');
    out.descripcion = d == null || d === '' ? null : d;
  }
  if ('estado' in body || !parcial) {
    const e = body.estado ?? 'pendiente';
    if (!ESTADOS.includes(e)) errores.push('estado debe ser uno de: ' + ESTADOS.join(', '));
    out.estado = e;
  }
  if ('prioridad' in body || !parcial) {
    const p = body.prioridad ?? 2;
    if (!Number.isInteger(p) || p < 1 || p > 3) errores.push('prioridad debe ser 1 (alta), 2 (media) o 3 (baja)');
    out.prioridad = p;
  }
  if ('vence_el' in body || !parcial) {
    const v = body.vence_el ?? null;
    if (v !== null && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v)))) errores.push('vence_el debe tener formato AAAA-MM-DD o ser null');
    out.vence_el = v;
  }
  if (parcial && !Object.keys(out).length && !errores.length) errores.push('Envía al menos un campo para actualizar');
  if (errores.length) throw new ApiError(422, 'Datos inválidos', errores);
  return out;
}

const COLUMNAS = "id, titulo, descripcion, estado, prioridad, to_char(vence_el, 'YYYY-MM-DD') AS vence_el, creado_en, actualizado_en";

/* ------------------------------------------------------------------ rutas */
let listo = false;

app.get('/health', wrap(async (_req, res) => {
  if (!listo) return res.status(503).json({ status: 'iniciando', pod: os.hostname() });
  await pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'up', pod: os.hostname() });
}));

app.get('/api', (_req, res) => res.json({
  nombre: 'API de tareas', version: '1.1.0', plataforma: process.env.PLATAFORMA || 'la PaaS', pod: os.hostname(),
  endpoints: {
    'GET /api/tareas': 'Listar (filtros: ?estado=&q=&page=&limit=)',
    'GET /api/tareas/:id': 'Obtener una tarea',
    'POST /api/tareas': 'Crear',
    'PUT /api/tareas/:id': 'Reemplazar',
    'PATCH /api/tareas/:id': 'Actualizar campos',
    'DELETE /api/tareas/:id': 'Eliminar',
    'GET /api/estadisticas': 'Conteo por estado',
  },
}));

app.get('/api/tareas', wrap(async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.estado) {
    if (!ESTADOS.includes(req.query.estado)) throw new ApiError(400, 'estado debe ser uno de: ' + ESTADOS.join(', '));
    args.push(req.query.estado); where.push('estado = $' + args.length);
  }
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    args.push('%' + req.query.q.trim() + '%'); where.push('(titulo ILIKE $' + args.length + ' OR descripcion ILIKE $' + args.length + ')');
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const filtro = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = (await pool.query('SELECT COUNT(*)::int AS n FROM tareas' + filtro, args)).rows[0].n;
  const { rows } = await pool.query(
    'SELECT ' + COLUMNAS + ' FROM tareas' + filtro + ' ORDER BY prioridad, id DESC LIMIT $' + (args.length + 1) + ' OFFSET $' + (args.length + 2),
    [...args, limit, (page - 1) * limit]);
  res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
}));

app.get('/api/tareas/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT ' + COLUMNAS + ' FROM tareas WHERE id = $1', [parseId(req.params.id)]);
  if (!rows.length) throw new ApiError(404, 'Tarea no encontrada');
  res.json(rows[0]);
}));

app.post('/api/tareas', wrap(async (req, res) => {
  const t = validar(req.body, false);
  const { rows } = await pool.query(
    'INSERT INTO tareas (titulo, descripcion, estado, prioridad, vence_el) VALUES ($1, $2, $3, $4, $5) RETURNING ' + COLUMNAS,
    [t.titulo, t.descripcion, t.estado, t.prioridad, t.vence_el]);
  res.status(201).location('/api/tareas/' + rows[0].id).json(rows[0]);
}));

async function actualizar(req, res, parcial) {
  const id = parseId(req.params.id);
  const t = validar(req.body, parcial);
  const keys = Object.keys(t);
  const sets = keys.map((k, i) => k + ' = $' + (i + 1));
  const { rows } = await pool.query(
    'UPDATE tareas SET ' + sets.join(', ') + ', actualizado_en = now() WHERE id = $' + (keys.length + 1) + ' RETURNING ' + COLUMNAS,
    [...keys.map((k) => t[k]), id]);
  if (!rows.length) throw new ApiError(404, 'Tarea no encontrada');
  res.json(rows[0]);
}
app.put('/api/tareas/:id', wrap((req, res) => actualizar(req, res, false)));
app.patch('/api/tareas/:id', wrap((req, res) => actualizar(req, res, true)));

app.delete('/api/tareas/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tareas WHERE id = $1', [parseId(req.params.id)]);
  if (!rowCount) throw new ApiError(404, 'Tarea no encontrada');
  res.status(204).end();
}));

app.get('/api/estadisticas', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT estado, COUNT(*)::int AS total FROM tareas GROUP BY estado');
  const porEstado = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  rows.forEach((r) => { porEstado[r.estado] = r.total; });
  res.json({ total: rows.reduce((a, r) => a + r.total, 0), porEstado });
}));

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Ruta no encontrada')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Errores siempre en JSON
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'JSON mal formado');
  if (err.type === 'entity.too.large') err = new ApiError(413, 'Cuerpo demasiado grande');
  if (!(err instanceof ApiError)) {
    console.error(err);
    err = new ApiError(err.code && /^(ECONN|57P|08)/.test(err.code) ? 503 : 500, 'Error interno del servidor');
  }
  res.status(err.status).json({ error: err.message, ...(err.detalles ? { detalles: err.detalles } : {}) });
});

/* ---------------------------------------------------------------- arranque */
async function iniciar() {
  for (let intento = 1; ; intento++) {
    try { await migrate(); listo = true; console.log('Base de datos lista (intento ' + intento + ')'); return; }
    catch (e) { console.error('BD no disponible (' + e.message + '); reintento en 3 s'); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

const server = app.listen(PORT, () => console.log('API de tareas escuchando en :' + PORT + ' (pod ' + os.hostname() + ')'));
iniciar();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(sig + ' recibido: cerrando conexiones');
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
