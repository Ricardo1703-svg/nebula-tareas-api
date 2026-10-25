'use strict';
// Pool de conexiones a la base de datos PostgreSQL administrada por Nébula Deploy.
// La plataforma inyecta DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD desde un Secret.
const { Pool } = require('pg');

// Sin valores por defecto: las credenciales solo existen en el panel de la PaaS
const faltan = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
if (faltan.length) {
  console.error('Faltan variables de entorno: ' + faltan.join(', ') + ' (configúralas en el panel de Nébula Deploy)');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('Error inesperado en el pool de PostgreSQL:', err.message));

// Migración idempotente: se ejecuta al arrancar cada réplica.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id          SERIAL PRIMARY KEY,
      titulo      VARCHAR(160) NOT NULL,
      descripcion TEXT,
      estado      VARCHAR(20)  NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'en_progreso', 'completada')),
      prioridad   SMALLINT     NOT NULL DEFAULT 2 CHECK (prioridad BETWEEN 1 AND 3),
      vence_el    DATE,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS productos (
      id             SERIAL PRIMARY KEY,
      codigo         VARCHAR(40) NOT NULL UNIQUE,
      nombre         VARCHAR(160) NOT NULL,
      categoria      VARCHAR(80) NOT NULL DEFAULT 'General',
      laboratorio    VARCHAR(120),
      descripcion    TEXT,
      precio         NUMERIC(12, 2) NOT NULL CHECK (precio >= 0),
      stock_minimo   INTEGER NOT NULL DEFAULT 5 CHECK (stock_minimo >= 0),
      activo         BOOLEAN NOT NULL DEFAULT TRUE,
      creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS lotes (
      id          SERIAL PRIMARY KEY,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
      codigo_lote VARCHAR(60) NOT NULL,
      vence_el    DATE NOT NULL,
      cantidad    INTEGER NOT NULL CHECK (cantidad >= 0),
      creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (producto_id, codigo_lote)
    );

    CREATE TABLE IF NOT EXISTS ventas (
      id         SERIAL PRIMARY KEY,
      total      NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
      creada_en  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS venta_detalles (
      id              SERIAL PRIMARY KEY,
      venta_id        INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
      producto_id     INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
      nombre_producto VARCHAR(160) NOT NULL,
      cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
      precio_unitario NUMERIC(12, 2) NOT NULL CHECK (precio_unitario >= 0),
      subtotal        NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0)
    );

    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      id          SERIAL PRIMARY KEY,
      producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,
      lote_id     INTEGER REFERENCES lotes(id) ON DELETE RESTRICT,
      tipo        VARCHAR(20) NOT NULL CHECK (tipo IN ('entrada', 'venta')),
      cantidad    INTEGER NOT NULL CHECK (cantidad > 0),
      referencia  INTEGER,
      creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_lotes_vencimiento ON lotes(vence_el);
    CREATE INDEX IF NOT EXISTS idx_ventas_creada_en ON ventas(creada_en DESC);
    CREATE INDEX IF NOT EXISTS idx_venta_detalles_venta ON venta_detalles(venta_id);
    CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos_inventario(producto_id, creado_en DESC);
  `);
}

module.exports = { pool, migrate };
