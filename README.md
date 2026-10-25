# Farmacia La Buena

Sistema web interno para administrar el catálogo de productos, las existencias por lote, los vencimientos y las ventas. Incluye una interfaz adaptable a móvil y una API REST construidas con Node.js, Express y PostgreSQL.

> Este despliegue está pensado para uso interno de confianza y no incluye inicio de sesión. No lo publiques en una red abierta sin añadir autenticación y controles de acceso.

## Funciones

- Resumen con ventas del día, productos activos, stock bajo y lotes próximos a vencer.
- Catálogo con búsqueda, edición de datos del producto y control de stock mínimo.
- Entradas de inventario identificadas por código de lote y fecha de vencimiento.
- Alertas para lotes vencidos y lotes que vencerán en los siguientes 90 días.
- Registro de ventas con transacción atómica y descuento de lotes con vencimiento más próximo (FEFO).
- Historial de ventas e historial de movimientos de entrada y salida de inventario.

## Requisitos y ejecución

- Node.js 20 o posterior.
- PostgreSQL 12 o posterior.

Configura estas variables en el entorno donde se ejecute el servicio:

| Variable | Descripción |
|---|---|
| `DB_HOST` | Host de PostgreSQL |
| `DB_PORT` | Puerto de PostgreSQL |
| `DB_NAME` | Nombre de la base de datos |
| `DB_USER` | Usuario de PostgreSQL |
| `DB_PASSWORD` | Contraseña de PostgreSQL |
| `PORT` | Puerto HTTP (opcional; por defecto `3000`) |
| `PLATAFORMA` | Etiqueta del entorno que se muestra en la API (opcional) |

Las cinco variables de base de datos son obligatorias; si falta alguna, el servicio termina e informa cuáles deben configurarse. Al arrancar, aplica migraciones idempotentes. La tabla previa `tareas` se conserva; las tablas nuevas de farmacia se agregan sin eliminar información existente.

```sh
npm ci
npm start
```

La interfaz queda disponible en `http://localhost:3000`.

## API

Los errores se devuelven como JSON. Los errores de validación usan `422` y pueden incluir `detalles`; un producto o lote duplicado devuelve `409`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de la base de datos |
| GET | `/api` | Información y rutas disponibles |
| GET | `/api/dashboard` | Métricas para el panel principal |
| GET | `/api/productos?q=&categoria=&alerta=&page=&limit=` | Buscar y filtrar productos |
| GET | `/api/productos/:id` | Consultar producto y existencias agregadas |
| POST | `/api/productos` | Crear producto |
| PATCH | `/api/productos/:id` | Editar producto o desactivarlo |
| GET | `/api/productos/:id/lotes` | Consultar lotes de un producto |
| POST | `/api/productos/:id/lotes` | Registrar una entrada de lote |
| GET | `/api/alertas/vencimiento?dias=90` | Lotes vencidos o próximos a vencer |
| GET | `/api/movimientos?producto_id=&limit=50` | Consultar movimientos de inventario |
| GET | `/api/ventas?limit=50` | Consultar ventas recientes |
| GET | `/api/ventas/:id` | Consultar venta y detalle |
| POST | `/api/ventas` | Registrar venta y descontar existencias |

`alerta` admite `stock` y `vencimiento`. La paginación de productos admite hasta 100 resultados por página. Los lotes con vencimiento anterior a la fecha actual no se incluyen en el stock disponible ni se pueden vender.

### Ejemplos

Crear un producto:

```sh
curl -X POST http://localhost:3000/api/productos \
  -H "Content-Type: application/json" \
  -d '{"codigo":"7501234567890","nombre":"Paracetamol 500 mg","categoria":"Medicamentos","laboratorio":"Laboratorios Buena Salud","precio":45.5,"stock_minimo":10}'
```

Registrar una entrada de inventario (sustituye `1` por el identificador del producto):

```sh
curl -X POST http://localhost:3000/api/productos/1/lotes \
  -H "Content-Type: application/json" \
  -d '{"codigo_lote":"LOTE-2026-01","vence_el":"2027-06-30","cantidad":40}'
```

Registrar una venta:

```sh
curl -X POST http://localhost:3000/api/ventas \
  -H "Content-Type: application/json" \
  -d '{"items":[{"producto_id":1,"cantidad":2}]}'
```

## Despliegue

La imagen Docker usa Node.js 20 Alpine, instala dependencias de producción y ejecuta el servicio como usuario sin privilegios. Configura las variables de entorno de la base de datos en el gestor de secretos de la plataforma; no guardes credenciales en el repositorio.
