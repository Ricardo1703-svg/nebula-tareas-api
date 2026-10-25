'use strict';

const os = require('os');
const path = require('path');
const express = require('express');
const { pool, migrate } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PRODUCT_FIELDS = ['codigo', 'nombre', 'categoria', 'laboratorio', 'descripcion', 'precio', 'stock_minimo', 'activo'];
const PRODUCT_COLUMNS = 'id, codigo, nombre, categoria, laboratorio, descripcion, precio, stock_minimo, activo, creado_en, actualizado_en';

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
  constructor(status, message, detalles) {
    super(message);
    this.status = status;
    this.detalles = detalles;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new ApiError(400, 'El id debe ser un entero positivo');
  return id;
}

function validarFecha(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
}

function validarProducto(body, parcial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Se espera un objeto JSON');
  const errores = [];
  const out = {};
  const desconocidos = Object.keys(body).filter((key) => !PRODUCT_FIELDS.includes(key));
  if (desconocidos.length) errores.push('Campos no permitidos: ' + desconocidos.join(', '));

  if (!parcial || 'codigo' in body) {
    const codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
    if (!codigo || codigo.length > 40) errores.push('codigo es obligatorio (hasta 40 caracteres)');
    out.codigo = codigo;
  }
  if (!parcial || 'nombre' in body) {
    const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
    if (!nombre || nombre.length > 160) errores.push('nombre es obligatorio (hasta 160 caracteres)');
    out.nombre = nombre;
  }
  if (!parcial || 'categoria' in body) {
    const categoria = body.categoria == null && !parcial ? 'General' : body.categoria;
    const categoriaTexto = typeof categoria === 'string' ? categoria.trim() : '';
    if (!categoriaTexto || categoriaTexto.length > 80) errores.push('categoria debe tener entre 1 y 80 caracteres');
    out.categoria = categoriaTexto;
  }
  if ('laboratorio' in body || !parcial) {
    const laboratorio = body.laboratorio ?? null;
    if (laboratorio !== null && (typeof laboratorio !== 'string' || laboratorio.trim().length > 120)) {
      errores.push('laboratorio debe ser texto de hasta 120 caracteres o null');
    }
    out.laboratorio = typeof laboratorio !== 'string' || laboratorio.trim() === '' ? null : laboratorio.trim();
  }
  if ('descripcion' in body || !parcial) {
    const descripcion = body.descripcion ?? null;
    if (descripcion !== null && (typeof descripcion !== 'string' || descripcion.length > 2000)) {
      errores.push('descripcion debe ser texto de hasta 2000 caracteres o null');
    }
    out.descripcion = descripcion == null || descripcion === '' ? null : descripcion;
  }
  if ('precio' in body || !parcial) {
    if (!parcial && !('precio' in body)) errores.push('precio es obligatorio');
    const precio = body.precio ?? 0;
    if (typeof precio !== 'number' || !Number.isFinite(precio) || precio < 0 || precio > 99999999) {
      errores.push('precio debe ser un número entre 0 y 99999999');
    }
    out.precio = Number.isFinite(precio) ? Math.round(precio * 100) / 100 : 0;
  }
  if ('stock_minimo' in body || !parcial) {
    const stockMinimo = body.stock_minimo ?? 5;
    if (!Number.isInteger(stockMinimo) || stockMinimo < 0 || stockMinimo > 2147483647) {
      errores.push('stock_minimo debe ser un entero mayor o igual a cero');
    }
    out.stock_minimo = stockMinimo;
  }
  if ('activo' in body || !parcial) {
    const activo = body.activo ?? true;
    if (typeof activo !== 'boolean') errores.push('activo debe ser booleano');
    out.activo = activo;
  }
  if (parcial && !Object.keys(out).length && !errores.length) errores.push('Envía al menos un campo para actualizar');
  if (errores.length) throw new ApiError(422, 'Datos inválidos', errores);
  return out;
}

async function transaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const PRODUCT_QUERY = `
  SELECT p.${PRODUCT_COLUMNS.split(', ').join(', p.')},
         COALESCE(SUM(l.cantidad), 0)::int AS stock,
         COALESCE(SUM(l.cantidad) FILTER (WHERE l.vence_el >= CURRENT_DATE), 0)::int AS stock_disponible,
         COALESCE(SUM(l.cantidad) FILTER (WHERE l.vence_el < CURRENT_DATE), 0)::int AS stock_vencido,
         MIN(l.vence_el) FILTER (WHERE l.cantidad > 0 AND l.vence_el >= CURRENT_DATE) AS proximo_vencimiento
    FROM productos p
    LEFT JOIN lotes l ON l.producto_id = p.id`;

async function obtenerProducto(id, executor = pool) {
  const { rows } = await executor.query(
    PRODUCT_QUERY + ' WHERE p.id = $1 GROUP BY p.id',
    [id]);
  return rows[0];
}

let listo = false;

app.get('/health', wrap(async (_req, res) => {
  if (!listo) return res.status(503).json({ status: 'iniciando', pod: os.hostname() });
  await pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'up', pod: os.hostname() });
}));

app.get('/api', (_req, res) => res.json({
  nombre: 'Farmacia La Buena',
  version: '2.0.0',
  plataforma: process.env.PLATAFORMA || 'la PaaS',
  pod: os.hostname(),
  endpoints: {
    'GET /api/dashboard': 'Resumen de inventario, vencimientos y ventas del día',
    'GET /api/productos': 'Catálogo con búsqueda, filtros y paginación',
    'POST /api/productos': 'Registrar producto',
    'PATCH /api/productos/:id': 'Actualizar producto',
    'GET /api/productos/:id/lotes': 'Consultar lotes',
    'POST /api/productos/:id/lotes': 'Registrar entrada de lote',
    'GET /api/alertas/vencimiento': 'Consultar lotes próximos a vencer o vencidos',
    'GET /api/movimientos': 'Consultar movimientos de inventario',
    'GET /api/ventas': 'Historial de ventas',
    'POST /api/ventas': 'Registrar venta y descontar inventario',
  },
}));

app.get('/api/dashboard', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM productos WHERE activo) AS productos,
      (SELECT COUNT(*)::int FROM (
        SELECT p.id FROM productos p LEFT JOIN lotes l ON l.producto_id = p.id
        WHERE p.activo GROUP BY p.id, p.stock_minimo
        HAVING COALESCE(SUM(l.cantidad) FILTER (WHERE l.vence_el >= CURRENT_DATE), 0) <= p.stock_minimo
      ) bajos) AS stock_bajo,
      (SELECT COUNT(*)::int FROM lotes WHERE cantidad > 0 AND vence_el BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS por_vencer,
      (SELECT COALESCE(SUM(total), 0)::numeric(12,2) FROM ventas WHERE creada_en >= date_trunc('day', now())) AS ventas_hoy,
      (SELECT COUNT(*)::int FROM ventas WHERE creada_en >= date_trunc('day', now())) AS transacciones_hoy
  `);
  res.json(rows[0]);
}));

app.get('/api/productos', wrap(async (req, res) => {
  const where = ['p.activo = TRUE'];
  const having = [];
  const args = [];
  if (typeof req.query.q === 'string' && req.query.q.trim()) {
    args.push('%' + req.query.q.trim() + '%');
    where.push('(p.codigo ILIKE $' + args.length + ' OR p.nombre ILIKE $' + args.length + ' OR p.categoria ILIKE $' + args.length + ')');
  }
  if (typeof req.query.categoria === 'string' && req.query.categoria.trim()) {
    args.push(req.query.categoria.trim());
    where.push('p.categoria = $' + args.length);
  }
  if (req.query.alerta === 'stock') having.push('COALESCE(SUM(l.cantidad) FILTER (WHERE l.vence_el >= CURRENT_DATE), 0) <= p.stock_minimo');
  if (req.query.alerta === 'vencimiento') having.push('MIN(l.vence_el) FILTER (WHERE l.cantidad > 0 AND l.vence_el >= CURRENT_DATE) <= CURRENT_DATE + 30');
  if (req.query.alerta && !['stock', 'vencimiento'].includes(req.query.alerta)) throw new ApiError(400, 'alerta debe ser stock o vencimiento');

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const filter = ' WHERE ' + where.join(' AND ');
  const havingClause = having.length ? ' HAVING ' + having.join(' AND ') : '';
  const base = PRODUCT_QUERY + filter + ' GROUP BY p.id' + havingClause;
  const countSql = `SELECT COUNT(*)::int AS total FROM (SELECT p.id FROM productos p LEFT JOIN lotes l ON l.producto_id = p.id${filter} GROUP BY p.id, p.stock_minimo${havingClause}) encontrados`;
  const [{ rows: countRows }, { rows }] = await Promise.all([
    pool.query(countSql, args),
    pool.query(base + ' ORDER BY p.nombre LIMIT $' + (args.length + 1) + ' OFFSET $' + (args.length + 2), [...args, limit, (page - 1) * limit]),
  ]);
  res.json({ data: rows, meta: { total: countRows[0].total, page, limit, pages: Math.ceil(countRows[0].total / limit) } });
}));

app.get('/api/productos/:id', wrap(async (req, res) => {
  const producto = await obtenerProducto(parseId(req.params.id));
  if (!producto) throw new ApiError(404, 'Producto no encontrado');
  res.json(producto);
}));

app.post('/api/productos', wrap(async (req, res) => {
  const producto = validarProducto(req.body, false);
  const { rows } = await pool.query(
    `INSERT INTO productos (codigo, nombre, categoria, laboratorio, descripcion, precio, stock_minimo, activo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PRODUCT_COLUMNS}`,
    [producto.codigo, producto.nombre, producto.categoria, producto.laboratorio, producto.descripcion, producto.precio, producto.stock_minimo, producto.activo]);
  res.status(201).location('/api/productos/' + rows[0].id).json(rows[0]);
}));

app.patch('/api/productos/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const producto = validarProducto(req.body, true);
  const keys = Object.keys(producto);
  const sets = keys.map((key, index) => key + ' = $' + (index + 1));
  const { rows } = await pool.query(
    `UPDATE productos SET ${sets.join(', ')}, actualizado_en = now() WHERE id = $${keys.length + 1} RETURNING ${PRODUCT_COLUMNS}`,
    [...keys.map((key) => producto[key]), id]);
  if (!rows.length) throw new ApiError(404, 'Producto no encontrado');
  res.json(rows[0]);
}));

app.get('/api/productos/:id/lotes', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: producto } = await pool.query('SELECT id FROM productos WHERE id = $1', [id]);
  if (!producto.length) throw new ApiError(404, 'Producto no encontrado');
  const { rows } = await pool.query(
    `SELECT id, codigo_lote, to_char(vence_el, 'YYYY-MM-DD') AS vence_el, cantidad
       FROM lotes WHERE producto_id = $1 ORDER BY vence_el, codigo_lote`,
    [id]);
  res.json({ data: rows });
}));

app.post('/api/productos/:id/lotes', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Se espera un objeto JSON');
  const codigoLote = typeof body.codigo_lote === 'string' ? body.codigo_lote.trim() : '';
  const errores = [];
  if (!codigoLote || codigoLote.length > 60) errores.push('codigo_lote es obligatorio (hasta 60 caracteres)');
  if (!validarFecha(body.vence_el)) errores.push('vence_el debe ser una fecha válida en formato AAAA-MM-DD');
  if (!Number.isInteger(body.cantidad) || body.cantidad < 1 || body.cantidad > 2147483647) errores.push('cantidad debe ser un entero positivo');
  const desconocidos = Object.keys(body).filter((key) => !['codigo_lote', 'vence_el', 'cantidad'].includes(key));
  if (desconocidos.length) errores.push('Campos no permitidos: ' + desconocidos.join(', '));
  if (errores.length) throw new ApiError(422, 'Datos inválidos', errores);

  const lote = await transaccion(async (client) => {
    const { rows: producto } = await client.query('SELECT id FROM productos WHERE id = $1 FOR UPDATE', [id]);
    if (!producto.length) throw new ApiError(404, 'Producto no encontrado');
    const { rows } = await client.query(
      `INSERT INTO lotes (producto_id, codigo_lote, vence_el, cantidad)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (producto_id, codigo_lote) DO UPDATE
         SET cantidad = lotes.cantidad + EXCLUDED.cantidad
         WHERE lotes.vence_el = EXCLUDED.vence_el
       RETURNING id, producto_id, codigo_lote, to_char(vence_el, 'YYYY-MM-DD') AS vence_el, cantidad`,
      [id, codigoLote, body.vence_el, body.cantidad]);
    if (!rows.length) throw new ApiError(409, 'El lote ya existe con una fecha de vencimiento diferente');
    await client.query(
      "INSERT INTO movimientos_inventario (producto_id, lote_id, tipo, cantidad) VALUES ($1, $2, 'entrada', $3)",
      [id, rows[0].id, body.cantidad]);
    return rows[0];
  });
  res.status(201).json(lote);
}));

app.get('/api/alertas/vencimiento', wrap(async (req, res) => {
  const dias = req.query.dias == null ? 90 : Number(req.query.dias);
  if (!Number.isInteger(dias) || dias < 0 || dias > 3650) throw new ApiError(400, 'dias debe ser un entero entre 0 y 3650');
  const { rows } = await pool.query(`
    SELECT l.id AS lote_id, l.codigo_lote, l.producto_id, p.codigo, p.nombre,
           to_char(l.vence_el, 'YYYY-MM-DD') AS vence_el, l.cantidad,
           (l.vence_el - CURRENT_DATE)::int AS dias_restantes
      FROM lotes l JOIN productos p ON p.id = l.producto_id
     WHERE l.cantidad > 0 AND l.vence_el <= CURRENT_DATE + $1
     ORDER BY l.vence_el, p.nombre
  `, [dias]);
  res.json({ data: rows });
}));

app.get('/api/movimientos', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const args = [];
  let filter = '';
  let limitParam = '$1';
  if (req.query.producto_id != null) {
    args.push(parseId(req.query.producto_id));
    filter = 'WHERE m.producto_id = $1';
    limitParam = '$2';
  }
  args.push(limit);
  const { rows } = await pool.query(
    `SELECT m.id, m.producto_id, p.codigo, p.nombre, m.lote_id, l.codigo_lote,
            m.tipo, m.cantidad, m.referencia, m.creado_en
       FROM movimientos_inventario m
       JOIN productos p ON p.id = m.producto_id
       LEFT JOIN lotes l ON l.id = m.lote_id
       ${filter}
      ORDER BY m.creado_en DESC LIMIT ${limitParam}`,
    args);
  res.json({ data: rows });
}));

app.get('/api/ventas', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const { rows } = await pool.query(
    `SELECT v.id, v.total, v.creada_en, COUNT(d.id)::int AS productos
       FROM ventas v LEFT JOIN venta_detalles d ON d.venta_id = v.id
      GROUP BY v.id ORDER BY v.creada_en DESC LIMIT $1`,
    [limit]);
  res.json({ data: rows });
}));

app.get('/api/ventas/:id', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: venta } = await pool.query('SELECT id, total, creada_en FROM ventas WHERE id = $1', [id]);
  if (!venta.length) throw new ApiError(404, 'Venta no encontrada');
  const { rows: detalles } = await pool.query(
    `SELECT id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal
       FROM venta_detalles WHERE venta_id = $1 ORDER BY id`,
    [id]);
  res.json({ ...venta[0], detalles });
}));

app.post('/api/ventas', wrap(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Se espera un objeto JSON');
  if (!Array.isArray(body.items) || !body.items.length) throw new ApiError(422, 'La venta requiere al menos un producto');
  if (body.items.length > 100) throw new ApiError(422, 'La venta no puede incluir más de 100 productos');
  const errores = [];
  const cantidades = new Map();
  body.items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.producto_id) || item.producto_id < 1) {
      errores.push('items[' + index + '].producto_id debe ser un entero positivo');
    } else if (!Number.isInteger(item.cantidad) || item.cantidad < 1 || item.cantidad > 100000) {
      errores.push('items[' + index + '].cantidad debe ser un entero positivo');
    } else {
      const extra = Object.keys(item).filter((key) => !['producto_id', 'cantidad'].includes(key));
      if (extra.length) errores.push('items[' + index + '] contiene campos no permitidos: ' + extra.join(', '));
      cantidades.set(item.producto_id, (cantidades.get(item.producto_id) || 0) + item.cantidad);
    }
  });
  if (Object.keys(body).some((key) => key !== 'items')) errores.push('Solo se permite el campo items');
  if (errores.length) throw new ApiError(422, 'Datos inválidos', errores);

  const venta = await transaccion(async (client) => {
    const productos = new Map();
    for (const productoId of [...cantidades.keys()].sort((a, b) => a - b)) {
      const { rows } = await client.query('SELECT id, nombre, precio, activo FROM productos WHERE id = $1 FOR UPDATE', [productoId]);
      if (!rows.length || !rows[0].activo) throw new ApiError(422, 'Uno de los productos no existe o está inactivo');
      productos.set(productoId, rows[0]);
    }

    const lineas = [];
    let totalCentavos = 0;
    for (const [productoId, cantidad] of cantidades) {
      const producto = productos.get(productoId);
      const centavos = Math.round(Number(producto.precio) * 100);
      const subtotalCentavos = centavos * cantidad;
      const maxCentavos = 999999999999;
      if (subtotalCentavos > maxCentavos || totalCentavos > maxCentavos - subtotalCentavos) {
        throw new ApiError(422, 'El total de la venta excede el límite permitido');
      }
      totalCentavos += subtotalCentavos;
      lineas.push({
        productoId,
        cantidad,
        nombre: producto.nombre,
        precio: (centavos / 100).toFixed(2),
        subtotal: (subtotalCentavos / 100).toFixed(2),
      });
    }

    for (const linea of lineas) {
      const { rows } = await client.query(
        `SELECT id, cantidad FROM lotes
          WHERE producto_id = $1 AND cantidad > 0 AND vence_el >= CURRENT_DATE
          ORDER BY vence_el, id FOR UPDATE`,
        [linea.productoId]);
      const disponible = rows.reduce((sum, lote) => sum + lote.cantidad, 0);
      if (disponible < linea.cantidad) {
        throw new ApiError(422, 'Inventario insuficiente para ' + linea.nombre + ' (disponible: ' + disponible + ')');
      }
      linea.lotes = rows;
    }

    const { rows: creada } = await client.query(
      'INSERT INTO ventas (total) VALUES ($1) RETURNING id, total, creada_en',
      [(totalCentavos / 100).toFixed(2)]);
    for (const linea of lineas) {
      await client.query(
        `INSERT INTO venta_detalles (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [creada[0].id, linea.productoId, linea.nombre, linea.cantidad, linea.precio, linea.subtotal]);
      let restante = linea.cantidad;
      for (const lote of linea.lotes) {
        if (!restante) break;
        const descontar = Math.min(restante, lote.cantidad);
        await client.query('UPDATE lotes SET cantidad = cantidad - $1 WHERE id = $2', [descontar, lote.id]);
        await client.query(
          "INSERT INTO movimientos_inventario (producto_id, lote_id, tipo, cantidad, referencia) VALUES ($1, $2, 'venta', $3, $4)",
          [linea.productoId, lote.id, descontar, creada[0].id]);
        restante -= descontar;
      }
    }
    return { ...creada[0], detalles: lineas.map(({ productoId, nombre, cantidad, precio, subtotal }) => ({ producto_id: productoId, nombre_producto: nombre, cantidad, precio_unitario: precio, subtotal })) };
  });
  res.status(201).location('/api/ventas/' + venta.id).json(venta);
}));

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Ruta no encontrada')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'JSON mal formado');
  if (err.type === 'entity.too.large') err = new ApiError(413, 'Cuerpo demasiado grande');
  if (err.code === '23505') err = new ApiError(409, 'El código de producto o de lote ya está registrado');
  if (!(err instanceof ApiError)) {
    console.error(err);
    err = new ApiError(err.code && /^(ECONN|57P|08)/.test(err.code) ? 503 : 500, 'Error interno del servidor');
  }
  res.status(err.status).json({ error: err.message, ...(err.detalles ? { detalles: err.detalles } : {}) });
});

async function iniciar() {
  for (let intento = 1; ; intento++) {
    try {
      await migrate();
      listo = true;
      console.log('Base de datos lista (intento ' + intento + ')');
      return;
    } catch (error) {
      console.error('BD no disponible (' + error.message + '); reintento en 3 s');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

const server = app.listen(PORT, () => console.log('Farmacia La Buena escuchando en :' + PORT + ' (pod ' + os.hostname() + ')'));
iniciar();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(sig + ' recibido: cerrando conexiones');
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
