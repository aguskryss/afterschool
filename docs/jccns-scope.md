# JCC North Shore — qué hay y qué falta

El JCCNS es el primer JCC que va a usar la plataforma. Este documento compara la
lista de features cerrada con ellos contra lo que hay hoy en el código, y ordena
lo que falta construir.

Escrito el 2026-08-02. Si tocás algo de esta lista, actualizá el estado acá mismo
para que el otro lo vea al entrar.

**No se elimina nada.** Todo lo nuevo se suma como **módulo** que el superadmin
prende por organización, porque el modelo es ese: el JCC arranca con un combo y
ampliar se cobra aparte. Eso resuelve la única tensión que había con el pedido
del JCCNS — pidieron sacar el flujo donde el parent anuncia que llegó, y con
módulos no hay que borrarlo del código: al JCCNS le dejamos `pickups` en **off**
y `secure_pickup` en **on**. Los JCCs que vengan después siguen teniendo la cola
en vivo disponible para venderles.

---

## Resumen

| # | Feature | Módulo | Estado |
|---|---|---|---|
| 1 | Attendance & Check-In | core + `check_in_out` | **Construido** — falta decidir rooms |
| 2 | Parent Absence Reporting | `absences` + `late_arrivals` | Parcial — falta llegada tarde y el aviso a staff |
| 3 | Roles & Secure Access | core | **Completo** |
| 4 | Push Notifications | `push` | **Completo** para lo construido |
| 5 | Assigned Activities & Activity Rosters | `activities` | Parcial — el upload sigue en el admin legacy |
| 01 | Secure Pickup (lista de autorizados) | `secure_pickup` | **Construido** |
| 02 | Daily Photos | `photos` | **Construido** — falta crear el bucket |
| 03 | Two-way Messaging | `parent_messaging` | **Construido** |

Lo construido no se probó todavía contra una base de datos real: en el
contenedor donde se escribió no había Postgres. Ver *Qué falta verificar*.

---

## Estado del sistema de módulos

**Hecho** (commit de este documento):

- Los 5 módulos nuevos existen en el catálogo (`server/tenancy.py`), todos con
  default `False`: `secure_pickup`, `check_in_out`, `photos`,
  `parent_messaging`, `late_arrivals`. Ya aparecen como toggles en
  `/app/organizations` — la consola dibuja lo que le devuelve
  `/api/superadmin/modules`, así que no hubo que tocar el frontend.
- **El enforcement server-side ahora existe.** Antes los toggles solo escondían
  pantallas: `module_enabled()` estaba definido y no lo llamaba ningún endpoint,
  así que cualquiera con un token válido podía pegarle al endpoint de un módulo
  apagado y recibir los datos. Ahora `tenancy.MODULE_ROUTES` mapea cada ruta a
  su módulo y un `before_request` en `app.py` devuelve 403.
- `tests/test_module_access.py` falla si alguien agrega una ruta `/api` que no
  esté ni mapeada a un módulo ni declarada como core. No necesita base de datos.

**Ojo al agregar un módulo nuevo:** son tres lugares, y los tres importan.
`MODULES` en `server/tenancy.py`, el type `ModuleKey` en `web/src/lib/auth.ts`,
y las rutas en `MODULE_ROUTES`. Si te olvidás del tercero, el toggle se ve pero
no protege nada.

**Y si una pantalla llama a un endpoint sin chequear `hasModule` primero**, con
el enforcement puesto ahora recibe un 403 en vez de datos. Eso ya pasó con dos:
`Account.tsx` pedía el estado de 2FA y `counselor/Schedule.tsx` pedía las
actividades, ambos módulos apagados por default. Los dos quedaron arreglados,
pero es el error a repetir.

---

## Auditoría detallada

### 1. Attendance & Check-In — PARCIAL

**Hay:** marcado por tap con autosave (`/api/counselor/attendance`,
`server/app.py:2611`), roster por counselor que ya filtra ausentes
(`counselor_get_roster`, `server/app.py:1462`), vistas admin de día / semana /
mes con charts y export CSV, y las pantallas `counselor/Today.tsx` y
`counselor/Roster.tsx`.

**Falta:**
- **Check-out.** `attendance_records` guarda un booleano `on_bus` por chico y día
  (`server/database.py:276`). No hay hora de entrada ni de salida.
- **Rooms.** No existe la entidad. Los chicos se agrupan por `schools` +
  `division_type` / `release_group` (`server/database.py:194-219`).
- **Headcount en vivo para el admin.** Las vistas admin son queries polleadas.
  El único canal realtime que hay hoy transporta pickups.

### 2. Parent Absence Reporting — PARCIAL

**Hay:** ausencias puntuales (`/api/parent/absences`), recurrentes y excepciones
en el backend, `parent/Calendar.tsx`, vista admin de ausencias con export.

**Falta:**
- **Llegada tarde.** No existe en ningún lado: ni columna, ni endpoint, ni UI.
- **Aviso instantáneo a counselors y admins.** `parent_mark_absence`
  (`server/app.py:991`) escribe en la DB y devuelve. No manda push, ni email, ni
  evento SSE. Hoy el staff se entera recién cuando abre la pantalla.
- Las ausencias recurrentes y las make-up classes existen en el backend pero
  **no están conectadas en la SPA**. Ver `docs/parity-audit.md`.

### 3. Roles & Secure Access — COMPLETO

Login único con cuatro roles, guards por rol en `web/src/App.tsx`, aislamiento
entre organizaciones por RLS (`server/tenancy.py`), 2FA TOTP, rate limiting de
login persistido, invitaciones + reset de password, y bulk invites que sobreviven
a más de un worker.

Los "separate portals" del copy son los dos shells que ya existen: `AppShell`
(móvil, parent y counselor) y `AdminShell` (desktop). **No hay que partir el
login** — CLAUDE.md lo prohíbe explícitamente y ya se pagó ese refactor una vez.

### 4. Push Notifications — PARCIAL

**Hay:** la infra completa — VAPID, subscribe / unsubscribe / test,
`public/sw.js`, y `send_push_to_user_async` (`server/app.py:2919`) que corre
fuera del thread del request.

**Ya disparan push:** llegada de pickup, claim de pickup, pedido de confirmación
de asistencia, make-up requests, todo el flujo de time-off, y el broadcast del
admin.

**Faltan los disparadores de lo nuevo:** ausencias, fotos nuevas, mensajes
parent↔admin, y el pickup/release nuevo.

### 5. Assigned Activities & Activity Rosters — PARCIAL

**Hay:** las tablas `activities`, `activity_schedules`, `activity_roster`,
`activity_completions` y `activity_roster_overrides`; endpoints admin completos
(upload, manual, assign, bulk-assign, schedules) y counselor
(`/api/counselor/activities` + complete); `counselor/Schedule.tsx` y
`admin/Program.tsx` en modo lectura.

**Falta:** el upload de archivo **solo existe en el admin legacy**. La SPA linkea
afuera (`web/src/routes/admin/Program.tsx:174-190`). Lo mismo con
`upload-roster`. La asignación manual y la bulk tampoco están en la SPA.

### Feature 01 · Secure Pickup — POR CONSTRUIR

No existe el concepto de persona autorizada.

El flujo actual (el parent anuncia que llegó → cola SSE → claim / unclaim)
**no se toca**: sigue siendo el módulo `pickups` y otros JCCs lo van a querer.
Al JCCNS simplemente se lo dejamos apagado. Lo nuevo vive en `secure_pickup` y
convive con lo viejo en el código, cada bloque detrás de su propio `hasModule`.

### Feature 02 · Daily Photos — POR CONSTRUIR

Cero referencias en todo el repo. No hay tabla, ni endpoint, ni storage, ni UI.

### Feature 03 · Two-way Messaging — POR CONSTRUIR

Lo que hay es broadcast en una sola dirección: admin → parents
(`admin_messages` + `parent_messages`, `server/database.py:452-478`). El parent
solo lee, marca leído y borra. No puede escribir.

---

## Qué falta verificar

Nada de lo construido corrió contra una base de datos. Lo que sí pasa:
`tests/test_module_access.py` (no necesita base), `python3 -m py_compile` sobre
todo el backend, y `tsc -b && vite build` sobre la SPA.

En cuanto tengas Postgres local o el deploy en Render:

1. `python3 tests/test_tenant_isolation.py` con `DATABASE_URL` y
   `ADMIN_DATABASE_URL`. Incluye el caso nuevo de fotos entre familias.
2. Aplicar las migraciones `19` → `26` **en orden**. La `19` antes que la `21`:
   el release escribe `checked_out_at`.
3. Crear el bucket **privado** en Supabase Storage y cargar `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY` y `SUPABASE_PHOTOS_BUCKET` en Render.
4. El 403 de módulos, que nunca se probó en vivo: apagar un módulo desde
   `/app/organizations` y pegarle al endpoint con curl. Tiene que dar 403.
5. Prueba con dos navegadores: entregar un chico y ver el push del lado del
   padre y el headcount moverse del lado del admin.

---

## Lista de build, en orden

### 0. Crear el JCCNS
Desde la consola superadmin (`/app/organizations`): crear la organización, cargar
su branding y prender los módulos que le corresponden — `pickups` en off,
`secure_pickup` / `check_in_out` / `photos` / `parent_messaging` /
`late_arrivals` en on. No requiere código.

### 1. Secure Pickup — módulo `secure_pickup`
Va primero porque el release del counselor **es** el check-out, así que bloquea
al punto 2.

- Migración en `sql/`: `authorized_pickup_people` (child_id, name, relationship)
  y `pickup_releases` (child_id, persona, counselor_id, released_at). Cada una
  con su rollback, su `organization_id` y su policy RLS.
- Backend: CRUD del parent sobre su lista; `POST /api/counselor/pickup/release`
  que valida que la persona esté autorizada para ese chico, escribe el release,
  cierra la asistencia del día y publica por `pickup_events.publish()`.
  Agregar los prefijos nuevos a `tenancy.MODULE_ROUTES`.
- Frontend: sección de personas autorizadas en el lado del parent; en
  `counselor/Today.tsx`, el selector de persona y la confirmación montados **al
  lado** del `PickupQueue`, cada bloque detrás de su propio `hasModule`.
- Push al parent cuando se confirma el release.

> El canal `LISTEN/NOTIFY` por organización **se mantiene**. CLAUDE.md prohíbe
> volver a un bus in-process, y con razón: rompe el fan-out entre workers. Pierde
> su consumidor actual y pasa a transportar releases y headcount en vivo, que es
> justo lo que pide el feature 1.

### 2. Attendance: check-out y headcount en vivo — módulo `check_in_out`
- Migración: hora de check-in y check-out en `attendance_records`. Agregar
  columnas sin romper `on_bus`, que lo usa el parser del roster upload.
- El check-out lo escribe el release del punto 1.
- Headcount del admin suscrito al canal SSE que ya existe.
- **Decisión abierta: rooms** (ver abajo). Si entran, entran acá.

### 3. Two-way Messaging — módulo `parent_messaging`
- Migración: conversación por parent + mensajes con `sender_role`, reusando
  `admin_messages` para el broadcast que ya funciona bien.
- Backend: envío del parent, respuesta del admin, unread de los dos lados.
- Frontend: `parent/Inbox.tsx` pasa de solo lectura a hilo con composer; bandeja
  del admin en `admin/Operations.tsx`.
- Push en ambas direcciones.

### 4. Daily Photos — módulo `photos`
- **Supabase Storage**, bucket privado. Credenciales nuevas en Render. El disco
  de Render es efímero, guardar archivos en el server no es opción.
- Migración: `photos` (uploader, fecha, storage path) y `photo_tags`
  (photo_id, child_id).
- Las policies RLS acá son críticas: un parent tiene que poder ver **solo** las
  fotos taggeadas con sus propios hijos. Es el punto de la lista donde una fuga
  duele más.
- Backend: upload del counselor con tagging; listado del parent devolviendo
  signed URLs de corta duración.
- Frontend: uploader en el shell del counselor, galería en el del parent.
- Push cuando se publican fotos nuevas.

### 5. Absences: llegada tarde y avisos — módulo `late_arrivals`
- Migración: tipo en `absences` (`absent` / `late`) con hora estimada.
- Push a los counselors asignados y a los admins al crearse.
- Conectar en la SPA las recurrentes y las excepciones que ya existen en backend.

### 6. Activities: traer el upload a la SPA — módulo `activities`
- Portar el upload de roster de actividades y el de roster general desde
  `public/admin/index.html`: es multipart con preview de mapeo de columnas y
  confirmación.
- Asignación manual y bulk en `admin/Program.tsx`.
- Es lo último que mantiene vivo al admin legacy.

### 7. Antes de entregar
- Apagar `SEED_TEST_ACCOUNTS` y `DEMO_MODE` en Render.
- Pasar el servicio de free a starter. En free se duerme a los ~15 minutos y eso
  mata cada stream SSE abierto — está comentado en `render.yaml`.

---

## Decisiones abiertas

- **Rooms.** El feature dice "live roster per room" pero hoy no existe la
  entidad. Hay que confirmar con el JCCNS si necesitan salones de verdad (tabla
  `rooms`, chicos y counselors asignados a un salón) o si alcanza con reusar
  school + división y llamarle "room" en la UI. Si necesitan salones de verdad,
  toca roster, attendance y actividades — conviene resolverlo antes de escribir
  la migración del punto 2.

---

## Al agregar cualquier tabla

1. La tabla va en `init_db()` de `server/database.py`.
2. La migración versionada va en `sql/`, **con su rollback**.
3. La policy RLS va en `server/tenancy.py`. Este es el paso que más fácil se
   olvida y el único que rompe el aislamiento entre JCCs.
4. Correr `python3 tests/test_tenant_isolation.py`, que es el test que prueba
   que un JCC no ve datos de otro. Necesita `DATABASE_URL` y
   `ADMIN_DATABASE_URL` apuntando a una base local.

## Al agregar cualquier endpoint de un módulo

1. El prefijo va en `MODULE_ROUTES` de `server/tenancy.py`.
2. La pantalla que lo llama chequea `hasModule` **antes** de hacer el fetch, o
   se come un 403.
3. Correr `python3 tests/test_module_access.py`, que falla si alguna ruta quedó
   sin decisión. No necesita base de datos.
