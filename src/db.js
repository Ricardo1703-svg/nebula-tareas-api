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
    )`);
}

module.exports = { pool, migrate };
