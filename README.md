# Kikar Afterschool

App del programa after-school: asistencia, ausencias, pickups en tiempo real,
fotos y mensajería con las familias. Tres roles —parent, counselor, admin—
sobre un login único, más un superadmin de plataforma que está por encima de las
organizaciones.

Cada JCC es una **organización**, y los features se venden por módulo: lo que un
JCC compró se prende con un toggle y se hace cumplir en el servidor.

## Dónde está corriendo

| | |
|---|---|
| Servicio Render | **`kikar-afterschool-tunz`** · `srv-d9n3krtaeets73b5ecr0` |
| URL | **https://afterschool.kikarlabs.com** |
| URL directa de Render | https://kikar-afterschool-tunz.onrender.com (sigue viva; sirve para probar salteando el DNS) |
| Proyecto Supabase | `trxnvcrjyqkbmbobjkys` (us-east-2) |
| Rama de deploy | `main`, con auto-deploy en cada push |

> El servicio se llama `-tunz` aunque `render.yaml` declare
> `name: kikar-afterschool`: cuando se aplicó el Blueprint ese nombre ya estaba
> tomado por un servicio creado a mano, y Render le agregó un sufijo. El de a
> mano ya se eliminó. **No cambies `name:` para que coincidan** — Render crearía
> un servicio nuevo en vez de renombrar el actual. Ver
> [`docs/handoff.md`](docs/handoff.md).

## Empezar

```bash
python3 -m pip install -r requirements.txt
cd web && npm ci && cd ..
./run-local.sh
```

Node 22 es obligatorio (Vite 8); está fijado en `.nvmrc`. `run-local.sh` levanta
Postgres local, carga `.env` y arranca Flask en :5001 con la SPA ya compilada.
Para desarrollar UI con HMR: `cd web && npm run dev`.

Los tests corren con el intérprete del venv — el `python3` del sistema en macOS
es 3.9 y no entiende la sintaxis de tipos del proyecto:

```bash
.venv/bin/python tests/test_module_access.py
```

Ese no necesita base de datos y falla si alguna ruta `/api` quedó sin decisión de
módulo. Corrélo siempre.

## Los documentos, y cuál leer

| Documento | Para qué |
|---|---|
| [`docs/handoff.md`](docs/handoff.md) | **Empezá acá.** En qué estado quedó todo, qué está verificado y qué no, y dónde están las trampas |
| [`CLAUDE.md`](CLAUDE.md) | Stack, restricciones críticas, convenciones, mapa del repo |
| [`docs/jccns-scope.md`](docs/jccns-scope.md) | El scope cerrado con el JCC North Shore, primer cliente |
| [`docs/deploy.md`](docs/deploy.md) | Levantar un entorno **desde cero**. Para operar el que ya existe, mirá el handoff |
| [`docs/parity-audit.md`](docs/parity-audit.md) | Qué del admin legacy se reconstruyó en la SPA y qué no |

## Las tres reglas

1. **Tabla nueva** → `init_db()` en `server/database.py` **y** `TENANT_TABLES` en
   `server/tenancy.py`. Sin lo segundo no tiene `organization_id` ni policy, y se
   filtra entre JCCs.
2. **Endpoint nuevo de un módulo** → `MODULE_ROUTES`. Sin eso el toggle se ve
   pero no protege nada.
3. **Pantalla que llama a un endpoint gateado** → `hasModule` antes del fetch, o
   se come un 403.

Al agregar un módulo son **tres** lugares: `MODULES` en `server/tenancy.py`, el
type `ModuleKey` en `web/src/lib/auth.ts`, y las rutas en `MODULE_ROUTES`.
