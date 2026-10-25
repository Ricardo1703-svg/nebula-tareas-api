# Tareas · App 2 (stack moderno) — Nébula Deploy

API RESTful en **Node.js 20 + Express** con **PostgreSQL 16** administrado.
Se despliega en la PaaS **Nébula Deploy**: cada `git push` a `main` se construye y publica solo.

## Variables de entorno
El código **no contiene credenciales ni cadenas de conexión**. Las genera la plataforma y las
inyecta desde un Secret de Kubernetes; se consultan en el panel (*Mis aplicaciones → Credenciales*).

| Variable | Origen |
|---|---|
| `DB_HOST`, `DB_PORT` | Servicio de la base de datos administrada |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Secret generado por Nébula Deploy |
| `NODE_ENV`, `PLATAFORMA` y las demás | Panel → *Editar* → Variables de entorno |

Si falta alguna, el proceso termina con un error explícito en lugar de usar valores por defecto.

## Endpoints
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/tareas?estado=&q=&page=&limit=` | Listar con filtros y paginación |
| GET | `/api/tareas/:id` | Obtener una |
| POST | `/api/tareas` | Crear (`201` + `Location`) |
| PUT | `/api/tareas/:id` | Reemplazar |
| PATCH | `/api/tareas/:id` | Actualizar campos |
| DELETE | `/api/tareas/:id` | Eliminar (`204`) |
| GET | `/api/estadisticas` | Conteo por estado |
| GET | `/health` | Sonda de readiness |

Errores en JSON: `400`, `404`, `422` (con `detalles`).

```bash
curl -X POST https://<tu-app>/api/tareas -H 'Content-Type: application/json' \
     -d '{"titulo":"Configurar Ingress","prioridad":1}'
```
