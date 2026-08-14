# CLAUDE.md

## 0. Antes de escribir código

Leer **[`docs/handoff.md`](docs/handoff.md)** (documento vivo, la sesión más
reciente arriba) y, si tocás algo del JCCSN, **[`docs/jccsn-daily-ops-spec.md`](docs/jccsn-daily-ops-spec.md)**
— es la fuente de verdad de las reglas de negocio del programa, sacada del
walkthrough con la directora. `docs/build-plan.md` tiene el plan por fases.

> `docs/parity-audit.md` está marcado como desactualizado. No lo uses para
> decidir qué falta: lista como MISSING cosas que existen hace tiempo.

## 1. Resumen del proyecto

**Kikar Afterschool** — Plataforma multi-tenant del programa after-school.
Cuatro roles (parent, counselor, admin, superadmin) sobre un login unificado.
Maneja asistencia, ausencias, pickups en tiempo real y notificaciones push.

Kikar es la plataforma; cada JCC es una **organización**. El modelo tiene
exactamente dos niveles: no hay sub-organizaciones, y `organization_id` es
siempre la respuesta completa a "¿de quién es esta fila?".

## 2. Stack

- **Backend**: Flask 3.1 (Python 3.11), `flask-jwt-extended`, `bcrypt`, `psycopg2`, `gunicorn`. Punto de entrada: `server/app.py` (~8,050 líneas, 146 rutas `/api/*`), más el blueprint `server/superadmin.py` (10 rutas bajo `/api/superadmin`).
- **DB**: PostgreSQL en Supabase (session-mode pooler). Schema en `server/database.py` + `server/tenancy.py`: **44 tablas, 42 con RLS activa** (las dos sin RLS son `app_settings` y `login_attempts`, globales a propósito).
- **Frontend**: SPA React 19 + Vite 8 + TypeScript + Tailwind 4 en `web/`, compilada a `public/app` y servida por Flask en `/app/*`. Service worker en `public/sw.js`.
- **Legacy**: `public/admin/index.html` sigue vivo — activity-roster y end-of-year no están reconstruidos. Adopta la sesión de la SPA (`kikar_auth`) para no pedir login dos veces.
- **Hosting**: Render (`render.yaml`).
- **Realtime**: SSE sobre Postgres `LISTEN/NOTIFY`, un canal por organización (`server/pickup_events.py`).
- **Seguridad**: 2FA TOTP (`pyotp`), web push con VAPID (`pywebpush`), rate-limiting de login persistido en DB.

## 3. Restricciones críticas

- **El login es único.** `/api/auth/login` devuelve el rol y el cliente rutea; no volver a partir el login por portal ni a crear namespaces de sesión por rol. **`public/admin/index.html` no autentica a nadie**: adopta `kikar_auth` o manda a `/app/login`. Nada fuera de la SPA puede linkear a `/parent`, `/counselor` o `/admin`, ni mandar un push o un mail ahí. `tests/test_no_legacy_portals.py` falla si aparece un formulario de login fuera de la SPA, una página HTML nueva en `public/`, o un link/push/mail a una ruta legacy.
- **Los eventos de pickup van por `LISTEN/NOTIFY` con canal por organización.** Nunca volver a un bus in-process: rompe el fan-out entre workers y hace que un JCC reciba pickups de otro.
- **El aislamiento entre organizaciones vive en RLS, no en los `WHERE`.** `DATABASE_URL` tiene que apuntar a un rol sin `BYPASSRLS`; `ADMIN_DATABASE_URL` es el rol dueño y solo lo usa `init_db()`.
- **Un módulo nuevo se declara en tres lugares, y los tres importan**: `MODULES` en `server/tenancy.py`, el type `ModuleKey` en `web/src/lib/auth.ts`, y las rutas en `MODULE_ROUTES`. Si te olvidás del tercero, el toggle se ve pero no protege nada. `tests/test_module_access.py` falla si una ruta `/api` nueva no está ni mapeada a un módulo ni declarada core.
- **Si una pantalla llama a un endpoint sin chequear `hasModule` primero**, recibe 403 en vez de datos. Es el error a repetir.
- **`maxconn=8` en el pool de DB** — Supabase pooler tope a 15 conexiones; durante deploys rolling de Render coexisten dos contenedores. Ver `server/database.py:13-22`.
- **`--threads 64`** — cada SSE abierto consume un thread por toda su vida.
- **Un evento nuevo que notifique a un padre se manda por `notify_parent()`**, nunca por `send_push_to_user_async()` directo. Es el único lugar que consulta las preferencias del JCC; una preferencia que la mitad de los eventos respeta es peor que ninguna. `tests/test_notification_settings.py` falla si un push a un `parent_id` la saltea.
- **`organizations` es superadmin-only por RLS** (`org_self` tiene `WITH CHECK (is_superadmin)`). Lo que el JCC administra va en una tabla de `TENANT_TABLES`, no en columnas de `organizations` — es lo que hace infalsificable el remitente de mail.
- **Todo thread que toque la DB tiene que pinear la organización** con `database.set_thread_organization()`, y resolverla **antes** de arrancar el thread. Sin eso `_resolve_organization()` devuelve `None`, RLS esconde todas las filas, y el trabajo falla en silencio pareciendo exitoso. Así estuvo roto el push entero. `tests/test_push_tenancy.py` falla si un `threading.Thread` nuevo no lo hace.
- **No usar `--no-verify`, ni amend commits, ni force-push.**

## 4. Comandos útiles

- Dev local (backend + SPA compilada): `./run-local.sh`
- Dev de UI con HMR: `cd web && npm run dev` (proxea `/api` a :5001)
- Build de la SPA: `cd web && npm run build` → `public/app`
- Install deps: `python3 -m pip install -r requirements.txt` y `cd web && npm ci`
- Matar dev server: `lsof -ti tcp:5001 | xargs kill -9`
- Seed test data: `python3 server/seed_test_data.py` · demo más grande: `python3 scripts/seed_demo.py`

**Tests** (`tests/`, scripts sueltos, no pytest — se corren uno por uno):

```bash
python3 -m py_compile server/*.py          # sintaxis
cd web && npx tsc -b && npm run build      # tipos + build

python3 tests/test_module_access.py        # no necesita DB
python3 tests/test_roster_import.py        # no necesita DB (el parser es puro)
python3 tests/test_org_email_identity.py   # no necesita DB (estático + funciones puras)
python3 tests/test_no_legacy_portals.py    # no necesita DB (estático)

# Los que sí necesitan DB, con DATABASE_URL y ADMIN_DATABASE_URL seteadas:
python3 tests/test_tenant_isolation.py
python3 tests/test_cross_tenant_api.py
python3 tests/test_module_enforcement.py
python3 tests/test_admin_children.py
python3 tests/test_dashboard_numbers.py
python3 tests/test_counselor_assignments.py
python3 tests/test_counselor_roster_fields.py
python3 tests/test_counselor_setup_link.py
python3 tests/test_setup_links.py          # links de padres y admins
python3 tests/test_org_branding.py          # logo y colores por organización
python3 tests/test_conversation_stream.py   # guardas del SSE de mensajería
python3 tests/test_push_tenancy.py          # el push corre con organización pineada
python3 tests/test_notification_settings.py # preferencias de notificación y el scheduler
python3 tests/test_child_status.py
python3 tests/test_operations_board.py
python3 tests/test_roster_staging.py
```

> **`DATABASE_URL` tiene que apuntar al rol de la aplicación, no a un
> superusuario.** Un superusuario saltea RLS por definición de Postgres, así
> que con uno los tests de aislamiento pasan sin probar nada — o fallan por
> razones que no tienen que ver con el código. `test_tenant_isolation.py` y
> `test_roster_staging.py` avisan en pantalla si detectan uno.

Después de importar un roster, `python3 scripts/verify_roster.py` reporta lo
que quedó en la base (conteos, reparto por escuela, días, horas de retiro,
contactos, asignaciones y el board del día) para comparar contra la planilla.
Es solo-lectura y seguro de correr en producción.

Node 22 es obligatorio (Vite 8); está fijado en `.nvmrc`.

## 5. Variables de entorno requeridas

`DATABASE_URL`, `ADMIN_DATABASE_URL`, `JWT_SECRET_KEY`, `ADMIN_INITIAL_PASSWORD`,
`ADMIN_EMAIL`, `ALLOWED_ORIGINS`, `FORCE_HTTPS`. Para mail: `RESEND_API_KEY` y
`EMAIL_FROM` (el proveedor por default ya es `resend`; la ruta SMTP existe pero
hay que pedirla con `EMAIL_PROVIDER=smtp` y usa `EMAIL_USER`/`EMAIL_PASS`).
`EMAIL_SENDER_DOMAIN` (default `kikarlabs.com`) es el dominio del que manda
**toda** organización — tiene que estar verificado en Resend. Para fotos:
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_PHOTOS_BUCKET` (**privado**)
y `SUPABASE_BRAND_BUCKET` (default `brand`, y tiene que ser **público** — los
logos se renderizan en `<img>` y dentro de mails abiertos semanas después,
donde una signed URL ya venció).

## 6. Convenciones

- DB access: usar `get_db()` (autocommit) o `get_db_transaction()` (autocommit OFF) de `server/database.py`. Nunca abrir conexiones crudas.
- Fechas validadas con `parse_date()` en formato `YYYY-MM-DD`. Timestamps al cliente siempre por `iso_utc()` — sin la `Z` final el browser los lee como hora local y muestra horas de más.
- Cambios de pickup state → siempre publicar por `pickup_events.publish()` para mantener clientes en sync.
- Migraciones SQL revisadas y versionadas en `sql/` con planes de rollback, y **espejadas como idempotentes en `init_db()`** para que un deploy anterior a aplicar el archivo converja igual.
- Toda tabla nueva multi-tenant se registra en `TENANT_TABLES` (`server/tenancy.py`); esa capa agrega `organization_id`, su default, FK, índice y la policy `org_isolation`. **No agregar esas columnas a mano en el `.sql`.**

## 7. Lo que NO hay que hacer

- No commitear `*.db`, `*.sqlite`, `vapid_keys.json`, `.env`, `node_modules/`, `public/app/`, `*.xlsx`/`*.xls`/`*.csv` ni `docs/source-files/` (ya en `.gitignore`). Las planillas del JCC traen nombre, DOB, alergias y teléfono de **menores reales**.
- No renombrar los strings `jclub` de `server/app.py` ~6351-6563: son valores de datos dentro de las planillas que se suben (nombres de programa en el export de Salesforce), no marca. Renombrarlos rompe los filtros. Ojo que estas líneas se corren solas cuando alguien edita `app.py` — buscá `'jclub'` antes de confiar en el número.
- **No agregar `email_from_local` a ninguna ruta que no sea de superadmin.** Cada organización manda desde `{slug}@kikarlabs.com` firmado con *nuestro* dominio verificado; un admin de JCC que pudiera elegir su local part podría tomar `noreply` o el slug de otro JCC y mandar mail que para SPF, DKIM y el padre que lo lee viene genuinamente de nosotros. Se escribe solo por `PATCH /api/superadmin/organizations/<id>`.
- **No guardar el remitente como dirección entera.** La columna guarda solo la parte antes del `@` y el dominio lo agrega `tenancy.org_from_email()`. Eso hace que el dominio sea infalsificable por construcción y no por acordarse de validar. Hay un CHECK en la DB que impone lo mismo.
- No cambiar el default del remitente sin verificar el dominio en Resend primero (hoy `noreply@kikarlabs.com`, `app.py:719`, solo el fallback de plataforma). Si el dominio no está verificado, Resend devuelve 403 y no sale ningún mail.
- No tocar archivos en `sql/` aplicados sin un plan de rollback.
- **No apuntar a Heather (ni a ningún JCC con `daily_ops`) al importador legacy** `/api/admin/upload-roster`: hace `UPDATE children SET active = 0` sin `WHERE` y reactiva solo lo que venga en el archivo, así que un archivo truncado da de baja al programa entero. Por eso la pantalla vieja está oculta cuando `daily_ops` está prendido (`AdminShell.tsx`, `unless: 'daily_ops'`). Mantenerlo así.

## 8. Dónde está cada cosa (mini-mapa)

```
kikar-afterschool/
├── server/
│   ├── app.py              # Flask — todas las rutas /api/*, auth, 2FA, push, SSE
│   ├── database.py         # Pool psycopg2 + init_db() con todo el schema
│   ├── tenancy.py          # Multi-tenancy: catálogo de módulos, TENANT_TABLES,
│   │                       # MODULE_ROUTES y las policies RLS (org_isolation)
│   ├── superadmin.py       # Blueprint /api/superadmin — consola de Kikar
│   ├── pickup_events.py    # Pub/sub sobre LISTEN/NOTIFY, un canal por organización
│   ├── roster_import.py    # Parser PURO del roster del JCC (sin flask ni psycopg2)
│   ├── roster_staging.py   # La mitad que habla con la DB: stagea y commitea
│   ├── bulk_invites.py     # Estado del job de invitaciones masivas (en DB)
│   ├── photo_storage.py    # Supabase Storage para las fotos (bucket PRIVADO, signed URLs)
│   ├── brand_storage.py    # Supabase Storage para los logos (bucket PÚBLICO)
│   └── seed_test_data.py   # Datos de prueba para desarrollo local
│
├── web/                    # SPA (React 19 + Vite + TS + Tailwind 4)
│   └── src/
│       ├── App.tsx         # Router: guard por rol + dos shells
│       ├── lib/            # api.ts (fetch + refresh), auth.ts (sesión única + módulos),
│       │                   # parent.ts (tipos de ausencias), usePickupStream.ts y
│       │                   # useHeadcountStream.ts (SSE)
│       ├── components/     # ui.tsx, DataTable, AppShell (mobile), AdminShell (desktop),
│       │                   # ModuleGuard, people.tsx, Brand
│       ├── styles/theme.css# Tokens de diseño — única fuente de color y tipografía
│       └── routes/         # Login, Account, parent/, counselor/, admin/, superadmin/
│
├── public/
│   ├── app/                # Build de la SPA (gitignoreado; lo genera Render)
│   ├── admin/index.html    # Admin legacy — solo lo no reconstruido
│   ├── reset-password/     # Flujo de reset password
│   ├── manifest.json       # PWA manifest (scope /app/)
│   └── sw.js               # Service worker (push + cache)
│
├── docs/                   # handoff.md (leer primero), spec del JCCSN, build-plan
├── sql/                    # Migraciones revisadas + rollbacks (pares: NN aplica, NN+1 revierte)
├── tests/                  # Scripts sueltos, no pytest. Ver §4
├── scripts/                # seed_demo.py, check_connection.py
├── requirements.txt        # Deps Python
├── render.yaml             # Deploy: pip install + npm ci + vite build
└── .nvmrc                  # Node 22
```

**Notas del mapa:**
- Casi todas las rutas `/api/*` viven en `server/app.py`; el único blueprint es `server/superadmin.py`.
- El color y la tipografía salen solo de `web/src/styles/theme.css`. No hardcodear hex en componentes.
- El wordmark está aislado en `web/src/components/Brand.tsx`: es una reproducción tipográfica hasta que llegue el vectorial.
- **Hay dos importadores de roster y no hacen lo mismo.** `/api/admin/upload-roster` (legacy, lee Excel **por posición**) y `/api/admin/roster-import` (nuevo, resuelve **por nombre de encabezado**, stagea un preview y recién commitea cuando un admin aprueba). El nuevo está detrás del módulo `daily_ops`. Ver §7.
- **`SSE` no pasa por los hooks de tenancy.** `EventSource` no manda `Authorization`, así que `_bind_tenant` y `_enforce_module_access` no ven token en `/api/*/stream`: los tres handlers de stream repiten a mano el decode, el pin de organización y el chequeo de módulo. Un stream nuevo tiene que repetirlo también.
