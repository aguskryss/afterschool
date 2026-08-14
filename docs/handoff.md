# Handoff

Documento vivo. **Toda sesión arranca leyendo esto y
[`jccns-scope.md`](./jccns-scope.md).** La sesión más reciente va primero; las
anteriores quedan abajo, no se borran.

---

## Sesión del 2026-08-06 (staff) — el turno de una persona, y los dos avisos

Rama: `claude/caregiver-assignment-schedule-vn9mnt`. El usuario mandó el
**workbook completo de Heather** (33 hojas) y describió el modelo entero: todo
por día de la semana, counselors asignados a cada actividad y — por hora — a
cada salón de CARE, y el counselor viendo lo suyo en su portal.

**Casi todo eso ya estaba hecho** (las ocho piezas del 2026-08-04/05). Lo que se
revisó y se cerró es el agujero que quedaba en la pantalla de asignación.

### Lo que el usuario decidió, y que acota el alcance

- **Los chicos se inscriben a las clases subiendo el Excel.** `class_enrollments`
  la sigue escribiendo sólo `roster_staging.commit()`. **No se agregó UI de
  inscripción** — se preguntó explícitamente y la respuesta fue que el chico se
  asigna a la clase cuando ella sube la planilla.
- **La hora de salida (3/4/5/6) sigue llegando sólo del import.**
  `/api/admin/children` PUT no la toca, y así queda.
- **Ninguna hoja nueva del workbook** (Sign Out, Bus, roster del día).

### Lo que se agregó

| | |
|---|---|
| `server/daily_routing.py` | `W_STAFF_OVERLAP`, `W_STAFF_GAP`, `assignment_span()`, `staff_overlaps()`, `covered_blocks()`, `staff_gaps()` — puro, sin DB |
| `server/app.py` | `_staff_people()` y, en `GET /api/admin/staff-assignments`, `people[]` + `staff_warnings[]` |
| `web/src/routes/admin/StaffSchedule.tsx` | alternador **By place / By person**, la tabla tipo `M-Staff`, y el picker que nombra a quien ya está ocupado esa hora |
| `tests/test_daily_routing.py` | 17 checks nuevos, sin DB |
| `tests/test_staff_assignments.py` | 15 checks nuevos, con DB |

Sin migración: `staff_assignments` ya tenía la forma. Sin módulo nuevo: la ruta
ya estaba en `MODULE_ROUTES` bajo `daily_ops` y detrás de `ModuleGuard`.

### Las cuatro decisiones que conviene no revisar

1. **Compartir un BLOQUE no es compartir tiempo.** Lillian da
   `Swim L1/2 3p-3:30p` y `Swim L3 3:30p-4p`, las dos dentro de 3-4, y `M-Staff`
   lo escribe como una sola celda `Swim L/T`. Por eso `assignment_span()`
   compara **horarios reales**, y una clase a la que le faltan las horas
   devuelve `None` en vez de caer al bloque entero: ese fallback es exactamente
   lo que reportaría las dos clases de Lillian como choque.
2. **Sólo se avisa por huecos INTERIORES.** Un 5-6 vacío es la persona que
   trabaja hasta las cinco, y en la hoja de papel eso es una celda en blanco, no
   un error. No hay dónde guardar las horas de contrato de nadie, así que avisar
   por el borde sería avisar por casi todo el staff y el aviso dejaría de
   leerse. Un hueco en el medio sí es una afirmación que el dato banca: están en
   el edificio de los dos lados.
3. **Ni el choque ni el hueco se rechazan con 409.** Se avisan. Un 409 bloquea
   el caso raro que nadie previó, y las dos cosas se deshacen en un click. El
   picker además marca al ocupado *antes* de guardar, con el lugar donde está.
4. **`staff_warnings` es su propio array, no se mezcla con `warnings`.** Ese
   cuenta lugares sin nadie; un banner que dijera "3 lugares no tienen a nadie"
   contando adentro una doble reserva sería, literalmente, falso.

### Verificado

Base local Postgres 16 con `kikar_app` sin BYPASSRLS (`[tenancy] Row level
security is enforced`). Pasan: `test_daily_routing`, `test_staff_assignments`,
`test_my_day`, `test_daily_board`, `test_daily_ops_care`, `test_daily_ops_rooms`,
`test_block_checks`, `test_module_access`, `test_module_enforcement`,
`test_tenant_isolation`, `test_cross_tenant_api`, `test_counselor_assignments`,
`test_operations_board`, `test_no_legacy_portals`, `test_roster_import`,
`test_org_email_identity`. `npx tsc -b` y `npm run build` limpios; la pantalla
manejada con Playwright sin errores de consola.

Con el Monday del workbook sembrado, la vista por persona sale así, y los dos
avisos son los dos que se plantaron a propósito:

```
Fischer   | Bball 3:15p-4p                        | —          | Ocean Room   <hueco 4-5>
Lillian   | Swim L1/2 3p-3:30p + Swim L3 3:30p-4p | —          | —            (sin aviso)
Mattea    | Gym + Bball 3:15p-4p                  | —          | —            <choque>
Avelyn    | Gym                                   | —          | —            (sin aviso)
```

### Una cosa rota que NO es de esta rama

`tests/test_daily_ops_classes.py` falla en **`the same name on the same day is
refused: expected 409, got 201`**. Se reproduce igual con el árbol sin tocar
(verificado con `git stash`). Es una aserción que quedó vieja cuando `sql/39`
amplió la identidad de una clase a `(organization_id, lower(name), day_of_week,
COALESCE(start_time, '00:00'))`: dos `Chess` del mismo lunes con horas distintas
ahora son legales a propósito. Hay que arreglar el test, no el código.

---

## Sesión del 2026-08-06 — rediseño tablet de `Today` y `My day` (mockup, no implementado)

El usuario pidió rediseñar las dos pantallas de counselor para **tablet en
landscape** (1180×820 y 1024×768), que es como se usan de verdad: iPad en el
brazo o en un carrito, en un gimnasio, sesiones de 15 segundos.

**Entregable: `docs/mockups/counselor-tablet.html`** — un solo archivo,
autocontenido, con las dos pantallas en tres estados horarios (llegada 3:12p,
programa 4:10p, salida 5:18p), toggle de orientación, y las notas de diseño
abajo. Es un **mockup con datos de muestra**: no toca `web/` ni el server.

### Lo que propone (todavía no está implementado)

- **La bottom tab bar se va.** 7 tabs → **rail izquierdo con 4 destinos** +
  identidad al pie. `Pickup` se pliega dentro de `Today` (la cola de padres es
  el panel derecho durante la salida), `Schedule` se parte entre el selector de
  día de `My day` y `Account`, y `Roster` pasa a llamarse `Children` porque
  chocaba con el roster de clase. La tabla completa está en las notas del HTML.
- **`Today`**: grilla de 6 escuelas sin scroll + panel derecho de excepciones
  (tarde, no ubicados, alertas de alergia). **Una sola razón por tarjeta**: un
  ratio, la barra es literalmente ese ratio, y el pill es el resto. El diseño
  viejo mostraba "0 de 4", barra a la mitad y "2 left" al mismo tiempo.
- **`My day`**: timeline de clases a la izquierda, **una clase por vez** a la
  derecha, agrupada **por destino** (Parent pickup / → próxima clase / care
  rooms) en dos columnas, con control de presencia por chico y confirmación por
  grupo.
- **Alergias**: un chico sin alergia no renderiza **nada** — ni "n/a", ni ícono.
  Hoy cada chico muestra un ícono rojo con "n/a", que es exactamente lo que
  entierra a los dos que sí tienen una alergia real.

### Dos reglas del dominio que el mockup respeta

- **R2**: un chico con salida 3:00p nunca aparece en un roster de clase, porque
  una clase nunca termina después de su hora de salida. La ola de las 3p existe
  y se ve en `Today`; correctamente no puede estar en `My day`.
- **R3**: el chico encadenado (Maya Feldman, Swim L3 → Yoga) está marcado en
  cuatro lugares para que nadie reporte el nombre duplicado como bug.

### Si se implementa

Toda pantalla tiene que chequear `hasModule('daily_ops')` **antes** de llamar al
endpoint (CLAUDE.md §3), y la cola de pickup plegada dentro de `Today` solo
aparece con `secure_pickup` prendido. El mockup no tiene módulos ni API.

---

## Sesión del 2026-08-06 (bis) — el JCC decide qué le llega a sus padres

El usuario pidió una pestaña de Communications/Notifications en el admin: para
mandar broadcasts, decidir **qué eventos** notifican al padre, y **a qué hora**
se les pregunta si los chicos vienen. Y avisó a mitad de camino que **ya no
están en el plan free** — pagan starter, lo que cambia si el scheduler puede
existir.

### La distinción que ordena todo

| | módulo | notificación |
|---|---|---|
| qué es | lo que el JCC **compró** | cómo el JCC **opera** |
| quién decide | superadmin | el admin del JCC |
| default desconocido | **cerrado** | **abierto** |

Un JCC que paga la cola de retiro puede igual no querer un push cada vez que un
counselor reclama a un chico. No es un producto más chico, es otra tarde.

Los defaults van al revés a propósito: un módulo desconocido es algo no pagado
y tiene que fallar cerrado; una notificación desconocida es un evento sobre el
que a ese JCC nunca se le preguntó, y esconderlo se vería como bug — pasa la
cosa, no llega el aviso, y nada en pantalla lo explica.

### RLS obligó el diseño, y estuvo bien

El primer intento puso las settings como columnas de `organizations`. El test
falló con `new row violates row-level security policy`: **la policy `org_self`
tiene `WITH CHECK (is_superadmin)`**, así que una organización no puede escribir
su propia fila. Eso es deliberado y carga peso — es lo que hace infalsificable
el remitente de mail de `sql/41`, en la base y no solo en una ruta.

**No se debilitó la policy.** Las settings se movieron a `notification_settings`,
una tabla de `TENANT_TABLES` donde `org_isolation` sí deja escribir a su dueño.
`organizations` sigue siendo superadmin-only.

### Una sola puerta para el push

`notify_parent(user_id, kind, ...)` es lo único que consulta las preferencias, y
los **cinco** eventos al padre pasan por ahí. Una preferencia que la mitad de
los eventos respeta es peor que ninguna: el admin destilda "child was picked up",
los push siguen llegando, y ahora la pantalla miente.

El test lo verifica por AST: busca llamadas a `send_push_to_user_async` cuyo
destinatario sea un `parent_id` y falla si encuentra alguna.

### El scheduler

`server/scheduler.py`, un ticker de 60s. Lo que lo hace no-trivial:

- **Corre una vez, no una por worker.** El claim es un `INSERT` en
  `scheduled_runs` con PK `(organización, job, fecha)`: el segundo conflictúa y
  no hace nada. Mismo truco que `bulk_invite_jobs`.
- **La hora es la del JCC.** Se compara contra su columna `timezone`; la 1 PM en
  Reno no es la 1 PM en Miami.
- **Tolera atraso pero no demasiado.** 20 minutos tarde sigue sirviendo; dos
  horas tarde los chicos ya se fueron y preguntar es ruido que erosiona los
  avisos que importan.

Hizo falta `database.set_thread_superadmin()`: el scheduler tiene que leer
**todas** las organizaciones para saber cuáles están en hora, y `organizations`
tiene `FORCE ROW LEVEL SECURITY` —ni el dueño de la tabla la saltea—. Encuentra
ancho y después **angosta** a una organización antes de tocar sus filas.

> **Esto depende de que la instancia esté despierta.** El free se apaga a los
> ~15 min de inactividad, que para un check de la 1 PM es exactamente cuando
> nadie usa la app. `render.yaml` pasó de `free` a **`starter`** en este commit.
> Volver a free desactiva en silencio todo `scheduler.py`.

También hay `POST /api/cron/run-due` con `CRON_SECRET` por si se prefiere un
cron externo. **Cerrado cuando el secreto no está seteado**, no abierto: un
endpoint que abanica push a todos los padres de todas las organizaciones no se
deja sin llave por default.

### La pantalla

Sección **Communications** en el nav: Broadcast (el Messages de siempre,
renombrado), Conversations y **Notifications**. El catálogo se renderiza desde
la lista del servidor, así que un evento agregado en `PARENT_NOTIFICATIONS`
aparece sin tocar el frontend.

Tiene un **"Send it now"**, porque una configuración cuyo efecto recién se ve a
la 1 PM de mañana es una configuración que nadie confía. Y avisa cuando las dos
settings se contradicen: si el switch de attendance check está apagado, el
horario registra la pregunta en la app pero no manda alerta.

### Lo que se rompió al probarlo, y la causa común

El usuario reportó tres cosas. Dos eran bugs y la tercera explicaba la primera.

**"Send it now" daba error.** `_run_attendance_check` reventaba en su primera
línea: `today_for_org()` devuelve un string `'YYYY-MM-DD'` y `_weekday_name()`
espera un `date`. Un `AttributeError` que ningún test estático habría agarrado
—es un error de tipo— así que el test ahora **llama la función de verdad**.

**El broadcast no llegaba, pero el mensaje directo al padre sí.** No era el
push: era **a quién se resuelve**. `_resolve_message_recipients` pasa por
`children` incluso con audiencia `'all'`, así que **un padre sin hijos asignados
es invisible para todo broadcast**. Se le puede escribir individualmente —eso va
por `parent_id`— y nunca recibe un anuncio.

**Y esa es la tercera pregunta**: no había forma de asignarle hijos a un padre
desde la SPA. El endpoint `POST /api/admin/children` existía desde siempre y
**nada lo llamaba**; solo el admin legacy tenía ese formulario.

Tres arreglos:

1. `AddChild` en la tabla de Parents, visible **solo para familias sin hijos**,
   que es el caso realmente roto. Con escuela y días.
2. La pantalla de composición **avisa** cuántos padres quedan afuera y por qué,
   en vez de dejar que el admin concluya que el broadcast está roto.
3. De paso: el contador de destinatarios leía `preview.count` y el servidor
   devuelve `recipient_count`, así que decía **"undefined parents"** al lado del
   botón Send — el único número con el que un admin verifica un envío a todas
   las familias antes de mandarlo.


## Sesión del 2026-08-06 — el push a padres nunca funcionó, y por qué no se notó

El usuario mostró que al agregar la app a la home de un iPhone aparece el icono
viejo de jclub, y pidió chequear a fondo el push de admin a padres. Lo del icono
era cierto. Lo del push era peor.

### EL BUG: todo push en background leía cero suscripciones

`push_subscriptions` es tabla tenant con RLS. `send_push_to_user()` hace
`get_db()`, y **todos los caminos de push pasan por un `threading.Thread`
pelado**: sin `flask.g`, sin pin de thread. `_resolve_organization()` devolvía
`None`, la conexión quedaba con `app.organization_id = ''`, y la policy
`org_isolation` no matcheaba nada.

**Cada push asíncrono leía cero filas y no mandaba nada.** Mensajes de la
oficina, chequeo de asistencia, pickup-claimed, decisiones de día libre. Todo.

**Se escondió por cómo fallaba.** El log decía `0 subscription(s) found`, que se
lee como "ese padre no activó notificaciones". Nada tiraba error, nada
reintentaba, y el broadcast del admin reportaba `attempted=N failed=0` habiendo
entregado a nadie.

El único push que funcionaba era el sincrónico de prueba, llamado directo desde
un request.

### El arreglo, y la regla que quedó escrita

`send_push_to_user_async()` **resuelve la organización antes de arrancar el
thread** y la pinea adentro — la misma disciplina que ya usaban
`_run_all_invites_job` y la identidad de mail. `_run_broadcast_pushes()` la
recibe como argumento obligatorio.

Y `send_push_to_user()` ahora **se niega a correr sin organización**, logueando
`[PUSH BUG]` en vez de un cero honesto. Las dos causas de "cero suscripciones"
tenían el mismo log, y esa ambigüedad es lo que ocultó el bug.

CLAUDE.md §3 tiene la regla ahora: **todo thread que toque la DB pinea la
organización, resuelta antes de arrancar**. `tests/test_push_tenancy.py` falla
si un `threading.Thread` nuevo no lo hace — resolviendo la función target por
AST, no por proximidad de líneas, porque el pin vive dentro del worker y a veces
a cientos de líneas del spawn.

> **Esto NO es lo que hacía que al usuario no le llegaran notificaciones en el
> iPhone del screenshot.** Ahí el aviso era correcto: en iOS el web push solo
> existe si la app está **instalada en la pantalla de inicio** (iOS 16.4+), y
> estaba en Safari. Pero el bug era real y habría seguido tapando todo apenas
> alguien se suscribiera.

### El icono era el de jclub, y el favicon que puse antes era el de Vite

Dos errores encadenados. El icono de PWA (`icon-192/512.png`) era el de jclub
pre-rebrand. Y **el `favicon.svg` que declaré en la sesión anterior era el bolt
violeta de Rolldown/Vite** — el default del scaffold, que estaba en
`web/public/` sin que nadie lo mirara. Lo declaré como marca de la plataforma
sin abrirlo.

**No hay vectorial de Kikar en el repo**, consistente con lo que dice
`Brand.tsx`. Los iconos nuevos (32/192/512) se generaron con Chromium desde la
**misma tipografía del wordmark** —Raleway Light, el woff2 que ya está en
`node_modules`— sobre un tile `#141b2b`. Es un sustituto fiel, no un logo nuevo:
cuando llegue el artwork real es cambiar tres PNG.

Sin `letter-spacing`: el tracking es lo que hace leer ancho a KIKAR, y sobre una
sola letra solo agrega un hueco que la descentra. El 32 va en peso 400 y no 300
porque un trazo fino desaparece en una pestaña.

### El pedido de notificaciones ahora se ofrece solo (hasta donde se puede)

El usuario instaló la app en la home del iPhone y **nada le sugirió activar
notificaciones**. Era cierto: `PushCard` vivía solo en la pantalla de Account, y
alguien que acaba de instalar no va ahí.

**Un prompt verdaderamente automático no es posible, y no es una limitación
nuestra.** Safari —o sea todo iPhone— solo honra `Notification.requestPermission()`
llamado desde **un gesto del usuario**. Disparado en mount no muestra nada: se
resuelve como denegado, y una denegación es casi permanente porque la única
vuelta atrás es Ajustes. Chrome sí deja llamarlo sin gesto y después lo castiga:
los sitios que preguntan al cargar se ganan el bloqueo automático.

Así que `PushPrompt` es lo más cercano honesto: **la tarjeta aparece sola** en la
primera pantalla de cada rol (home del padre, Today del counselor, dashboard del
admin), y **el tap es lo que la plataforma exige** para abrir el diálogo real.

Solo se muestra cuando el estado es `off` —soportado, módulo prendido, todavía
sin suscribir—. En Safari de iPhone sin instalar, la Push API directamente no
existe: el estado es `unsupported` y la tarjeta no aparece, porque no hay nada
que conceder hasta que la app esté en la pantalla de inicio. Esa explicación
sigue en Account.

El "Not now" se recuerda **14 días**. Un banner que vuelve en cada visita es
cómo alguien aprende a tocar la X sin leer, y después deniega el permiso para
que pare.

> **Dato de iOS que conviene tener a mano**: la PWA instalada tiene su **propio
> contenedor de storage**, separado de Safari. Hay que volver a loguearse
> adentro de la app instalada — la sesión de Safari no viaja.


## Sesión del 2026-08-05 (septies) — favicon, fotos del admin, y "todas las fotos"

### El favicon existía y nadie lo declaraba

`web/public/favicon.svg` estaba en el repo desde hace tiempo. **Ningún
documento tenía un `<link rel="icon">`**, así que el browser pedía
`/favicon.ico`, comía un 404 y mostraba el globo genérico. Y el archivo solo
quedaba en `public/app/favicon.svg` después del build, o sea fuera del alcance
de `/`, `/admin` y `/reset-password`.

Se copió a `public/favicon.svg` —`static_url_path=''` lo sirve en la raíz— y se
declaró en los **cuatro** documentos: la landing, la SPA, el admin legacy y el
reset. Con fallback a `icon-192.png`, porque Safari no soportó favicons SVG
hasta 2023 y es la mitad de los teléfonos donde corre esto. Los links van
**después** de `<meta charset>`, que tiene que estar en los primeros 1024 bytes.

### El admin ya podía subir fotos, pero no había por dónde

`app.py` acepta `'admin'` en el upload desde siempre, y tiene una rama que le
deja taguear **cualquier** chico de la organización en vez de solo los de su
roster. Lo que faltaba era la UI: `AdminPhotos.tsx` era solo moderación.

El uploader nuevo usa un **buscador**, no una grilla de chips como el del
counselor: un counselor tiene un puñado de chicos en su roster de hoy, un admin
elige entre los 156 del JCC. El botón está deshabilitado sin tags, porque **el
tag es lo que decide quién ve la foto** — una foto sin taguear se sube y no la
ve nadie.

### "Todas las fotos", porque "hoy" estaba vacío casi siempre

Las fotos no se suben todos los días, así que una pantalla scopeada a hoy
estaba vacía la mayor parte del tiempo — y una grilla vacía al lado de un date
picker no dice **qué días sí tienen algo**. Se leía como feature rota en vez de
como un martes tranquilo.

`GET /api/counselor/photos?date=all` saca el filtro de día. El admin **abre en
All** y el filtro por día queda para cuando sabés la fecha; el counselor
mantiene "hoy" por default —está subiendo lo de esta tarde— con un toggle
"Show all". Cuando la grilla cruza días, cada tile muestra su fecha. **`all`
nunca llega al uploader**: subir con ese filtro puesto archiva bajo hoy.

La galería del padre ya no tenía filtro de fecha, así que ese lado ya estaba
bien.

### Un problema de performance que ya existía

`signed_url()` es **una llamada HTTPS a Supabase por foto**, y la galería del
padre pide hasta 200 filas: hasta 200 requests secuenciales reteniendo un
thread de gunicorn. No había dolido porque hay pocas fotos, pero una vista sin
filtro de día lo convierte en el caso normal.

`photo_storage.signed_urls()` firma la página entera en **una sola llamada**,
con fallback al camino de a uno si la llamada en lote falla, y `None` por
objeto que no se pudo firmar: una foto ilegible es un hueco en la grilla, nunca
una pantalla en blanco. `PHOTO_PAGE_LIMIT = 200` y el cliente **avisa** cuando
la página vino llena, en vez de presentar un año truncado como si fuera todo.

### Sobre álbumes: se decidió no hacerlos

El usuario preguntó día-vs-álbumes. Se quedó día + tag. **El tag ya hace el
trabajo del álbum y además es la frontera de privacidad**: `/api/parent/photos`
devuelve solo las fotos donde el chico está tagueado, y eso es toda la
separación entre una familia y otra.

Un álbum obliga a contestar quién lo ve: si se filtra por tag igual, es una
etiqueta más y ya existe `photo_date`; si se ve entero, le mostrás a un padre
fotos de hijos ajenos. Lo segundo es un cambio de política de privacidad
disfrazado de feature de organización.

Si en algún momento hace falta agrupar por evento con nombre ("Purim 2026"), la
forma barata es **una columna `event TEXT` nullable en `photos` y un filtro** —
no una entidad nueva, y el tag sigue siendo la frontera.

---

## Sesión del 2026-08-05 (sexies) — la mensajería deja de necesitar F5

El usuario reportó que el inbox padre↔admin funciona pero **las respuestas solo
aparecen refrescando**. Del lado admin había un `refetchInterval: 60_000`; del
lado del padre, nada.

### Se agregó una sola conexión nueva, y esa es la decisión

**Cada SSE abierto se queda con un thread de gunicorn de por vida, y hay 64**
(CLAUDE.md §3). Los padres son los muchos, así que un stream por padre habría
sido la mitad cara de esta feature.

Resultó que **`/api/parent/stream` ya existía en el servidor y ningún cliente lo
consumía** — estaba muerto del lado del browser desde el rewrite a la SPA. Así
que los padres reciben los mensajes por ahí: solo hubo que agregar
`conversation-message` a su `allowed_types`, que ya filtra por `parent_id`.
Cero conexiones nuevas para el lado numeroso.

Los admins sí tienen endpoint propio, `/api/admin/conversations/stream`. No
comparte `/api/pickups/stream` porque ese está gateado por el módulo `pickups`:
un JCC que compró mensajería y no la cola de retiro se quedaría sin su propio
inbox. Son un puñado por JCC y solo mientras la pantalla está abierta.

**Los hooks se montan en la pantalla, no en la app.** La conexión vive
exactamente lo que dura alguien mirando una conversación. Un stream global
retendría un thread por cada padre que dejó la pestaña abierta en otra página.

### Dos detalles que se habrían escapado

**`resync`.** `pg_notify` topa en 8000 bytes y `pickup_events.publish()` ya
degrada a un evento `resync` vacío cuando el payload no entra — o sea, **un
mensaje largo**. Ese evento no lleva `parent_id`, así que el filtro por
destinatario del feed de padres lo habría descartado, dejando justo al mensaje
largo como el único que no llega. Ahora se reenvía a todos antes de filtrar: no
lleva contenido, y su único trabajo es decir "refetch".

**El poll de 60s del admin se dejó.** No como duplicado sino como red: si el
EventSource se cae y todavía no reconectó, eso es silencioso desde adentro. Con
la red puesta, un minuto de desactualización es el peor caso en vez del normal.

Los dos lados invalidan react-query en vez de insertar el mensaje en el caché.
El thread es chico y la copia del servidor es la que tiene bien el orden y el
estado de leído. Del lado admin **una sola invalidación alcanza** para la lista,
el thread abierto y el badge: react-query matchea por prefijo de key.

### `tests/test_conversation_stream.py` — 16 checks, con DB

Cubre todo lo que tiene que ser rechazado: sin token, token basura, rol
equivocado, token sin organización, y **una organización sin `parent_messaging`**
— que es la que avisa CLAUDE.md §8, porque el hook no vio token y dejó pasar la
request.

No cubre el camino feliz: un stream exitoso es un generador infinito y el test
client de Flask consume el body hasta el final, así que pedirlo colgaría la
suite en vez de aprobarla.

Sí cubre, estáticamente, que el publisher y los dos forwarders coincidan en el
string del evento — un typo en cualquiera de los tres es un mensaje que se manda
y nunca llega.

---

## Sesión del 2026-08-05 (quinquies) — tres limpiezas del portal admin

Misma rama. El usuario miró el portal de un admin y separó tres cosas: el
selector de counselors muestra gente de más, "Activities" y "Activity times" no
parecen tener nada que ver con nada, y el rango de grados llega hasta 12 en un
programa que termina en quinto.

### 1. Los nombres de más en el staff picker son admins, y ahora se ve

`_STAFFABLE_ROLES = ('counselor', 'admin')` (`app.py:5009`) es a propósito y está
documentado: una directora cubriendo un salón ella misma es normal. El problema
no era quiénes están en la lista sino que **una vez que son nombres en una
píldora, un admin y un counselor se leen igual** — de ahí "me salen counselors
que ya borré".

**Se preguntó y el usuario eligió dejarlos**, marcados por color. Los admins van
en grape (`bg-grape-50 text-grape-600`) más la palabra `admin`, en el picker y
en la píldora del que ya está asignado. El rol sale de `data.counselors`, que ya
viene con `role` — no hizo falta tocar el backend.

> No hay borrado blando de counselors: `DELETE /api/admin/counselors/<id>` borra
> la fila, y todas las FK a `users(id)` son CASCADE o SET NULL (se verificó en
> `server/` y `sql/`). Si alguna vez aparece de verdad un counselor borrado en
> una lista, el sospechoso es `DeletePerson` (`components/people.tsx`), que no
> tiene `onError`: un 409 no muestra nada y la fila se queda.

### 2. Activities / Activity times no son lo mismo que Classes

Se revisó antes de tocar nada, y son dos modelos distintos:

| | Activities · Activity times | Classes |
|---|---|---|
| Módulo | `activities` | `daily_ops` |
| Qué carga | su propio Excel (`/api/admin/activity-roster/upload`) | el roster del JCC (`/api/admin/roster-import`) |
| Qué guarda | `activities`, `activity_roster`, `activity_schedules` | `class_sessions`, `class_enrollments` |
| Qué es | roster de drop-off/pickup, un counselor por chico y por acción | el catálogo de clases que lee el motor de ruteo |

`roster_staging.commit()` escribe `class_sessions` y `class_enrollments` y
**nunca toca las tablas de `activities`**. "Activity times" es todavía más
acotado: son horas por defecto matcheadas contra el nombre de la actividad, y
las usa solo ese importador. O sea que en un JCC con `daily_ops` las dos
pantallas solo pueden estar vacías.

Se llegó a poner `unless: 'daily_ops'` en `AdminShell` y **se revirtió**: el
usuario apagó el módulo `activities` para ese JCC desde la consola de superadmin,
que es exactamente para lo que está. Un `unless` habría cableado en el código una
decisión que ya se puede tomar por organización, y habría escondido las pantallas
incluso en un JCC que algún día quisiera las dos cosas. En `AdminShell` quedó el
comentario que explica la diferencia, para que la próxima persona no vuelva a
preguntarse si son lo mismo que Classes.

### 3. Los grados paran en quinto, pero como piso y no como constante

`AddRule` ofrecía K-12 (`Array.from({length: 13})`). El daño no es el scroll: un
mis-click escribe una regla para un grado que el programa no tiene, y ese grado
después aparece en la línea roja de "grados sin salón" como si fuera un hueco
real — que es exactamente lo que se ve en la captura ("Grades 5, 6 have no room
in this hour").

`DEFAULT_TOP_GRADE = 5`, y sube solo si hay chicos registrados más arriba. La
extensión mira `data.grades` **filtrado por `children > 0`**: ese array es la
unión de los grados del roster con los que nombran las reglas, así que sin el
filtro una regla vieja K-12 mantendría vivo el 6 al 12 en el picker que la
volvería a crear. El backend sigue aceptando 0-12 a propósito: si alguna regla
alta ya existe, se sigue viendo y se puede borrar.

### Lo que se tocó

| | |
|---|---|
| `StaffSchedule.tsx` | admins en grape, en el picker y en el asignado |
| `AdminShell.tsx` | solo un comentario: Activities no es Classes |
| `CareRules.tsx` | `DEFAULT_TOP_GRADE`, `topGrade` bajando a `AddRule` |

Sin cambios de backend, de schema ni de tests. `npx tsc -b` + `npm run build`,
`py_compile`, `test_module_access` y `test_no_legacy_portals` en verde (los de
DB no se corrieron: no hay Postgres en este entorno).

---

## Sesión del 2026-08-05 (quater) — el JCC ve su logo, no el nuestro

Misma rama. El usuario pidió subir el logo a un bucket propio, que se vea como
logo del JCC en toda la app, y un color wheel en vez de escribir hex a mano.

**Dos decisiones se preguntaron y se resolvieron así:** solo superadmin edita
branding (queda donde ya vivía), y el logo del JCC **reemplaza del todo** el
wordmark KIKAR — white-label, no co-branding.

### El bucket de logos es público, y el de fotos no. Son opuestos a propósito

Por eso `brand_storage.py` es un módulo separado de `photo_storage.py` en vez
de un parámetro más:

| | `photos` | `brand` |
|---|---|---|
| Visibilidad | **privado** | **público** |
| Lectura | signed URL de 1 hora | URL estable |

Las fotos son de menores y no pueden ser legibles por URL sola. El logo tiene
el requisito inverso y **una signed URL no puede cumplirlo en dos lugares**: en
cada pantalla de la app habría que re-firmar en cada carga para mostrar algo
que no es secreto, y **en el mail de invitación no funciona en absoluto** —
quien lo abre no tiene sesión, y puede abrirlo tres semanas después, cuando
cualquier firma ya venció.

Compartir un módulo dejaría un solo `_config()` entre un store privado por
diseño y uno público por diseño. Las ~40 líneas de HTTP duplicadas son el error
más barato.

> **Hay que crear el bucket a mano**: Supabase → Storage → New bucket, llamado
> `brand`, marcado **público**. Uno privado no falla ruidosamente: sirve 400 en
> lugar de cada logo, en la app y en el mail.

**El primer intento real de subida falló, y el mensaje era malo.** Volvía:

```
Upload failed (400): {"statusCode":"404","error":"Bucket not found",...}
```

Exacto e inútil: no dice qué bucket, ni dónde crearlo, ni que tiene que ser
público. Y venía como **400**, que se lee como "tu imagen está mal" para un
problema que no tiene nada que ver con la imagen.

`brand_storage._explain()` ahora mapea los errores de Supabase a algo
accionable, y `StorageError` lleva un flag `setup`: **400 culpa al archivo, 503
culpa al deployment**, y quien lo lee solo puede arreglar uno de los dos.

### Y después el logo subió bien y siguió sin verse: era la CSP

Con el bucket creado y **público**, la subida funcionó y la imagen igual
apareció rota. **No era Supabase, era nuestro propio header.**
`server/app.py:653` mandaba:

```
img-src 'self' data:
```

O sea el browser rechazaba **cualquier** imagen que no viniera de nuestro
origen. Supabase es otro origen. Y una violación de CSP no es un error que la
app pueda reportar: es un warning en la consola del browser de otra persona.

**La galería de fotos tenía exactamente la misma falla y nadie la había
notado**, porque el módulo `photos` viene apagado por default. Renderiza
`<img src={signed url de Supabase})` y estaba igual de bloqueada.

Ahora es `img-src 'self' data: https:`. Nombrar solo el origen de Supabase
arreglaría el logo subido y dejaría roto el fallback de URL pegada — el mismo
fallo silencioso un paso más adelante.

Lo que cuesta, dicho claro: un `<img>` inyectado podría señalar una carga o
meter datos en una URL. Lo que **no** cuesta es ejecución de código. Y ojo —
**`script-src` ya permite `'unsafe-inline'`**, así que quien pueda inyectar
markup tiene una herramienta mucho mejor que un tag de imagen. Apretar
`img-src` con eso en pie sería teatro. **El orden para arreglarlos es
`script-src` primero.**

Hay un check nuevo que compara los tokens de la directiva, no substrings: el
scheme pelado `https:` es distinto de `https://cdn.jsdelivr.net`, y confundirlos
hace leer un allowlist de tres CDNs como "cualquier host de internet".

> **Diagnóstico equivocado, dicho para el próximo**: se apuntó primero al
> bucket privado, que era la hipótesis razonable y estaba mal. Cuando una
> imagen no carga y la URL es correcta, mirar la consola del browser antes que
> la configuración del storage.

### Se guarda el path, no la URL

`sql/43` agrega `logo_path`. Convive con `logo_url` con precedencia explícita:
subido gana, pegado es fallback, ninguno es el wordmark. `tenancy.org_logo_url()`
es la única respuesta y **toma la fila entera** — si alguien se olvida de poner
`logo_path` en el `SELECT`, revienta con `KeyError` en vez de caer en silencio
a la columna vieja y mostrar un logo viejo.

El path lleva un uuid por subida. No es decoración: el storage lo cachea fuerte,
así que pisar `org-3/logo.png` dejaría el logo anterior en pantalla por un
tiempo indeterminado. Nombre nuevo = URL nueva = aparece al toque.

**El orden de operaciones del upload es el diseño**: subir, después actualizar
la fila, y **recién ahí** borrar el objeto anterior. Si falla la subida no
cambió nada; si falla el update queda un huérfano de unos KB; el borrado va
último y no puede fallar ruidosamente. Borrar o actualizar primero pondría una
imagen rota frente a todos los padres del JCC durante la ventana intermedia.

### El color wheel, y por qué además muestra contraste

`<input type="color">` es el picker del sistema, con cuentagotas en todos los
browsers de escritorio. Al lado queda el campo de texto, porque pegar un hex de
un manual de marca es como se usa de verdad y a la rueda no se le pega nada.

Se agregó `web/src/lib/contrast.ts` (WCAG 2.1). **`brand_primary` no es
decoración: es el fondo detrás de texto blanco en cada botón primario.** Un JCC
con un amarillo pálido termina con botones blanco-sobre-amarillo legibles en el
monitor del diseñador e invisibles en el teléfono de un counselor a pleno sol.

El preview es **un botón real en el color real**, no un swatch: un swatch
responde "qué color es", y la pregunta que importa es "¿se lee la etiqueta?".
**Nunca bloquea el guardado** — es la marca de ellos; el trabajo de la consola
es avisar, no vetar.

### `refreshContext()` existía y nadie la llamaba

Estaba escrita hace tiempo, con su docstring explicando que sirve para que un
cambio de superadmin llegue sin desloguear. **Cero llamadas.** Así que branding
y módulos solo cambiaban para quien se deslogueaba y volvía a entrar. Un logo
que la mayoría no ve por días no es una feature. Ahora se llama en `main.tsx`,
sin await: la primera pintura ya usó los valores cacheados.

### Lo que se tocó

| | |
|---|---|
| `sql/43` + `sql/44` | `logo_path`, espejado en `init_db()` |
| `server/brand_storage.py` | nuevo — bucket público, cap de 2 MB, SVG permitido |
| `server/tenancy.py` | `org_logo_url()` con la precedencia |
| `server/superadmin.py` | `POST`/`DELETE` `/organizations/<id>/logo` |
| `web/src/components/Brand.tsx` | `OrgLogo` — white-label con fallback al wordmark |
| `AppShell` · `AdminShell` | 4 lugares donde estaba el wordmark |
| `web/src/lib/contrast.ts` | nuevo |
| `Organizations.tsx` | tarjetas Logo y Colours separadas |
| `tests/test_org_branding.py` | **40 checks**, con DB |

### Detalles que quedaron anotados

- **El login no puede mostrar el logo del JCC.** Login único, sin subdominio por
  organización: hasta que no vuelven las credenciales el servidor no sabe de qué
  JCC es quien está tecleando. Esa pantalla se queda con `Lockup`.
- **SVG está permitido y el razonamiento depende de quién sube.** Un `<img>`
  nunca ejecuta script de un SVG, y el bucket es otro origin que el de la app.
  Eso vale **porque solo suben superadmins**. Si algún día se abre a los admins
  de JCC, hay que revisarlo: un SVG no confiable pasa a ser un script hosteado
  en el mismo origin de Supabase que sirve las signed URLs de las fotos. Está
  escrito en `brand_storage.py`.
- **Bug propio, atrapado por los tests**: `_organization_context` quedó llamando
  `org_logo_url(row)` sin el prefijo del módulo. `NameError` en **login**, o sea
  nadie entraba. Lo agarró la corrida completa, no el test nuevo.
- La preview de la consola va sobre un damero: la mayoría de los logos son PNG
  transparentes y un fondo blanco esconde por completo una marca blanca.

### Estado de la suite

**16/16 pasan** — 4 sin DB y 12 con DB, en el Postgres local con roles reales.
`test_org_branding` se corrió en las **dos ramas**: con Supabase sin configurar
(el logo subido cae al fallback en vez de reventar) y con credenciales ficticias
(gana el subido y sale por `/object/public/`). No se ejercita el POST real a
Supabase: un test que necesita red para pasar falla por razones que no son el
código.

---

## Sesión del 2026-08-05 (ter) — onboarding por link, sin depender del mail

Misma rama. El usuario preguntó por qué registra un padre y no le llega el mail
para crear la contraseña, y pidió poder hacerlo también por link.

### Por qué no llegaba: eran tres razones apiladas

1. **Crear un padre nunca mandó mail.** Es a propósito y solo pasa con padres
   (`admin_add_parent`): counselors y admins sí reciben uno al crearse. **Pero
   el botón decía "Add and send invitation"** en los tres casos. El admin
   apretaba, no se mandaba nada, y esperaba un mail que no existía.
2. `PARENT_INVITES_ENABLED` tiene que estar en `1`, si no las dos rutas de
   invitación a padres devuelven 403.
3. `RESEND_API_KEY` tiene que estar cargada. Hoy está como
   `RESEND_API_KEY_OFF` a pedido del usuario.

El link ya existía **solo para counselors** (`admin_counselor_setup_link`),
agregado cuando se descubrió que el proveedor de mail era opcional. Padres y
admins no lo tenían, así que con el mail apagado las únicas cuentas que un JCC
podía dar de alta eran las de sus counselors.

### Qué se agregó

| | |
|---|---|
| `POST /api/admin/parents/<id>/setup-link` | nueva |
| `POST /api/admin/admins/<id>/setup-link` | nueva |
| `POST /api/admin/parents` | ahora **devuelve** `setup_url` en la respuesta |
| `people.tsx` | `SetupLinkBox` extraído; el alta de padre muestra el link al instante |
| `People.tsx` | botón "Get link" en las tablas de padres y admins; label del alta corregido |
| `tests/test_setup_links.py` | **45 checks**, con DB |

**Lo más importante: no está gateado por `PARENT_INVITES_ENABLED`.** Ese flag
frena *mails*; esta ruta no manda ninguno, le da un link al admin que está
frente a la pantalla. Gatearlo lo desactivaría justo en la situación para la que
existe. Hay un check que fija esa distinción: con el flag apagado,
`resend-invite` tiene que dar 403 y `setup-link` tiene que dar 200.

Hereda del counselor las dos cosas que **no** hace: no manda mail, y **no toca
`password_hash`** — `resend-invite` sí lo rota antes de mandar, así que con el
mail roto deja afuera a alguien que ya tenía contraseña y no avisa. Tampoco
estampa `invited_at`: no se mandó ninguna invitación, y marcarla pondría
"Invitation sent" al lado de una casilla vacía.

### Un credencial que estaba en los logs

`admin_add_parent` hacía `print(f"... Setup URL pending admin send: {setup_url}")`.
Eso ponía **un link de seteo de contraseña vivo, de un padre con nombre y
apellido, en el log de la aplicación** de cada deploy — legible por cualquiera
con acceso al dashboard de Render y retenido mucho después de que el token
expire. Ahora el link va en la respuesta al admin que acaba de crear la cuenta,
y el log solo dice el email.

### Se levantó Postgres local y se corrieron los tests con DB

Primera vez en estas sesiones. Cluster con la separación de roles real
(`kikar_owner` dueño, `kikar_app` sin `SUPERUSER` ni `BYPASSRLS`), `init_db()`
converge, y pasan: `test_tenant_isolation`, `test_cross_tenant_api`,
`test_module_enforcement`, `test_admin_children`, `test_counselor_setup_link`,
`test_child_status` y el nuevo `test_setup_links`.

De paso quedó verificado contra la base que el CHECK de `sql/41` rechaza un
`UPDATE organizations SET email_from_local='evil@attacker.com'` directo por SQL,
no solo por la API.

> `pywebpush` no compila en este entorno (`http-ece` falla al buildear). Es un
> import opcional en `app.py`, así que los tests corren igual, pero **nada de lo
> que se probó acá ejercita push**.

---

## Sesión del 2026-08-05 (bis) — el portal viejo deja de tener puerta

Misma rama. El usuario reseteó su contraseña, y en vez de la app le apareció
**el portal legacy**: card teal, "Administrator Portal / Attendance Management",
formulario de login propio y un link que ofrecía volver a **"portal selection"**
—una pantalla que no existe hace rato—. Pidió que ese estilo de web no pueda
volver a aparecer, con un chequeo exhaustivo.

### Dos cosas dormidas que se apuntaban entre sí

Ninguna de las dos era visible por separado.

1. **`public/reset-password/index.html` mapeaba rol → portal**:
   `{ parent: '/parent', counselor: '/counselor', admin: '/admin' }`. Los dos
   primeros redirigen a `/app/`, así que funcionaban de casualidad. **`/admin`
   sirve el portal legacy**, así que todo admin que seteaba una contraseña
   aterrizaba ahí.
2. **El admin legacy tenía un login completo**: email, password, campo de 2FA,
   su propio `fetch('/api/auth/login')` y un "This portal is for administrators
   only". Nadie linkeaba a eso, que es exactamente por qué sobrevivió.

Una ruta muerta más un formulario muerto = un camino vivo.

### Qué se hizo

| | |
|---|---|
| `reset-password/index.html` | siempre a `/app/login`; se borró el mapa de roles — esta página no tiene por qué saber que existen roles |
| `public/admin/index.html` | **se eliminó el login entero**: markup, CSS del card teal, `doLogin()`, el link de portal selection. Ahora adopta `kikar_auth` o hace `location.replace('/app/login')` |
| `server/app.py` | **11 URLs** de push y mail que apuntaban a rutas legacy |
| `web/src/routes/counselor/MyDay.tsx` | lee `?date=` para que el deep link de reasignación caiga en la tarde correcta |
| `tests/test_no_legacy_portals.py` | **21 checks**, sin DB |

El login se **borró**, no se escondió: un form oculto está a un cambio de CSS
de volver a ser visible.

### El grep manual no alcanzó, y esa es la lección

Encontré 3 URLs legacy leyendo. **El test encontró 11.** Las que se me
escaparon usaban `url=` como keyword y f-strings:

```
url='/admin/#makeups'                       → /app/makeup
url='/admin/#time-off'          (x2)        → /app/timeoff
url='/counselor/#time-off'      (x3)        → /app/schedule
url=f'/counselor/?day=week#date={...}' (x3) → /app/my-day?date=...
url='/parent#inbox'  ·  url='/parent/'      → /app/inbox · /app/home
send_push_to_user(_async) default url='/'   → '/app/'
{base_url}/parent  en el mail de asistencia → /app/home
```

Las dos peores: el default de `send_push_to_user` mandaba a la **landing de
marketing**, y las de `/admin/#...` caían **directo en el portal viejo**.

`MyDay` no leía la fecha de la URL, así que apuntar el deep link sin tocar la
SPA habría dejado al counselor en "hoy" para una notificación sobre otro día.
Se agregó `?date=` en vez de degradarlo en silencio.

### El guard, que es lo que pidió

`tests/test_no_legacy_portals.py` falla si: aparece un `.html` en `public/`
fuera del allowlist de tres; el admin legacy recupera cualquier superficie de
login; alguna página linkea a `/parent`, `/counselor` o `/admin`; el reset
vuelve a rutear por rol; un push o un mail apunta a una ruta legacy; o el
puente de sesión empieza a **escribir** `kikar_auth` en vez de solo leerlo.

Verificado con mutación: las cuatro formas de romperlo fallan. El test ignora
comentarios, porque si no, explicar por qué se borró el login contaba como
tenerlo.

**El allowlist de páginas es la parte que importa a futuro.** Agregar un HTML
a `public/` ahora es una decisión explícita que hay que justificar en el test,
no algo que pasa sin que nadie mire.

### Lo que NO se tocó

- **El admin legacy sigue vivo y sigue con su estilo viejo por dentro.**
  Activity-roster y end-of-year no están reconstruidos (CLAUDE.md §2). Lo que
  se sacó es la *puerta*, no la casa: ya no se llega ahí sin pasar por la SPA.
- **`launchDemo()` (view-as) está roto y se dejó roto**, con el comentario que
  lo explica. Escribe `jclub_token_*`, que la SPA ignora. Escribir `kikar_auth`
  **no** es el arreglo: localStorage es compartido entre pestañas, así que
  reemplazaría la sesión del admin en la pestaña que está usando. Necesita
  `sessionStorage` sembrado desde un token de un solo uso en la URL. `DEMO_MODE`
  está apagado en producción.

---

## Sesión del 2026-08-05 — el remitente deja de ser `jclubapp.com`

Rama: `claude/render-resend-env-variable-5nmq69`. Cambio chico y de una sola
línea de código, pero toca lo que decide si sale o no sale un mail.

**La variable de Resend es `RESEND_API_KEY`** (`server/app.py:715`), y el
proveedor por default ya es `resend` — no hace falta setear `EMAIL_PROVIDER`.
La API key **ya está cargada en Render**, y el dominio que se está verificando
en Resend es **`kikarlabs.com`**.

**El default del remitente pasó de `noreply@jclubapp.com` a
`noreply@kikarlabs.com`** (`server/app.py:721`). Era el último rastro del
dominio pre-rebrand en código. La cadena sigue siendo la misma —
`EMAIL_FROM` → `EMAIL_USER` → default— así que las entradas viejas de este
handoff que hablan de `jclubapp.com` describen el estado anterior, no el actual.

Esto **importa más de lo que parece**: el `from` que se manda es
`"{EMAIL_FROM_NAME} <{EMAIL_FROM}>"` (`app.py:750`), y Resend rechaza con
**403** cualquier envío desde un dominio que no esté verificado. Con el default
viejo, aunque la API key estuviera bien cargada, todo envío fallaba en silencio
salvo que `EMAIL_FROM` estuviera seteada. Igual conviene setearla explícita en
Render y no depender del default.

`EMAIL_FROM_NAME` se queda en `Kikar Afterschool`, que ya era el default.

### Segunda mitad: cada JCC manda desde su propia dirección

El usuario preguntó si el remitente podía depender de la organización que
contrató. Sí, y salió barato porque **Resend verifica dominios, no
direcciones**: con `kikarlabs.com` verificado, cualquier `*@kikarlabs.com` sale
sin configuración extra. Un dominio propio por JCC habría significado registros
SPF/DKIM en un DNS que no controlamos, un ticket de soporte por cliente, y —lo
que de verdad cuesta— la reputación de envío repartida en varios dominios fríos
en vez de acumulada en uno tibio.

Lo que ve un padre ahora es `JCC of Northern Nevada <jccns@kikarlabs.com>` con
`Reply-To` al admin del JCC. **Sin configurar nada**: el slug es el local part
de fallback.

| | |
|---|---|
| `sql/41` + `sql/42` | tres columnas nullable en `organizations`, con CHECK |
| `server/tenancy.py` | `EMAIL_SENDER_DOMAIN`, los dos regex, `org_from_email()`, y el espejo idempotente |
| `server/app.py` | `EmailIdentity`, `email_identity()`, `_ambient_org_id()`, `_email_shell()`, `_cta()` |
| `server/superadmin.py` | los tres campos en el PATCH, validados |
| `web/src/routes/superadmin/Organizations.tsx` | tarjeta *Outgoing email* con preview |
| `tests/test_org_email_identity.py` | **70 checks**, sin DB |

**La columna guarda el local part, no una dirección, y eso es el punto.** Una
columna `email_from` con la dirección entera dejaría mandar como cualquier
dominio —incluido el de otro JCC, o el nuestro— y la validación es algo que te
podés olvidar de correr en el próximo endpoint que la escriba. Guardando solo
`jccns` y agregando el dominio en `org_from_email()`, **no existe valor que
escape**: el `@` se rechaza al entrar, y aunque entrara produciría
`a@b@kikarlabs.com`, que no es una entrega a `a@b`. El CHECK en la DB impone lo
mismo para escrituras que no pasen por la API.

**Solo superadmin escribe estos campos**, y no es una decisión de permisos
común: es el único campo donde lo que un tenant escribe cambia lo que ven los
destinatarios de *otro*. Un admin de JCC que pudiera elegir su local part podría
tomar `noreply` y mandar mail que para SPF, DKIM y el padre que lo lee viene
genuinamente de nosotros. `tests/test_org_email_identity.py` falla si aparece
`email_from_local` en cualquier lugar de `app.py` que no sea `email_identity()`.

### La trampa del diseño, que es la parte que importa

La organización se sabe de tres maneras y **no se superponen**:

| Contexto | Cómo |
|---|---|
| Request normal | `flask.g`, puesto por `_bind_tenant` |
| Job de invitaciones masivas | el pin de thread, puesto por `_run_all_invites_job` |
| `send_email_async()` | **ninguna de las dos** |

Ese tercero es el que decidió el diseño. Leer `g` fuera de app context no
devuelve `None`: **tira `RuntimeError`**. Y si en vez de eso se resolviera la
identidad adentro de `send_email()`, el thread pelado caería al default de
plataforma y mandaría con branding de Kikar a los padres de un JCC, en verde,
sin fallar nada.

Por eso **`identity` es un argumento obligatorio, sin default, de todas las
funciones de envío**, y se resuelve en el call site mientras todavía hay
contexto. Convierte el error en un `TypeError` al importar en vez de un `From:`
equivocado que nadie mira. Los tests hacen mutación de esto: si le ponés
`identity=None` por default, o resolvés adentro, o le sacás el argumento a un
call site, fallan.

El job masivo resuelve **una vez** para toda la corrida, no por padre: un roster
de 400 serían 400 SELECT extra contra un pool de 8.

### Los mails ahora leen el branding que la tabla ya tenía

`organizations` venía guardando `logo_url`, `brand_primary` y `brand_accent`
desde hace tiempo, y **email era la única superficie que nunca los leyó**. Los
templates tenían `Kikar Afterschool` y `#005F6B` hardcodeados en siete lugares.
Ahora hay un `_email_shell()` y un `_cta()` y el color, el logo y el nombre
salen de la fila de la organización.

De paso, todo lo interpolado pasa por `html.escape` (importado como `_escape`
porque `html` es una variable local en medio archivo). Antes un chico llamado
`Ben & Jerry` rompía el render.

**El teléfono hardcodeado se fue.** El footer de la invitación a padres tenía
`(786) 284-1205` fijo: la línea de soporte de un JCC impresa en el mail de
todas las organizaciones, que es incorrecto apenas hay una segunda. Ahora el
footer depende de si la organización tiene `Reply-To`: con uno, "Questions?
Just reply to this email"; sin uno, "contact {nombre de la org} directly".

Eso convierte a `email_reply_to` en el lugar donde vive el canal de contacto de
cada JCC — que es donde tiene que estar, en su propia fila y no en un literal
del template.

### Lo que quedó sin tocar, a propósito

- **`admin@kikarafterschool.com`** (`server/app.py:6252`) — es el `sub` de los
  `vapid_claims`, un mailto de contacto para el push service, no un remitente.
  No es `jclubapp`, pero es otro dominio que quizás no existe. **Nadie confirmó
  si ese dominio es nuestro**; se deja anotado.
- **`testparent@jclub.com` / `testcounselor@jclub.com`** (`app.py:1917-1918`,
  `seed_test_data.py`) — son las cuentas sembradas del demo, y las direcciones
  son la clave con la que `_DEMO_ACCOUNTS` matchea filas ya existentes en la
  base. Cambiarlas rompe `DEMO_MODE` contra cualquier base ya sembrada. No son
  un remitente: nunca sale un mail desde ahí.

---

## Sesión del 2026-08-04 (salas) — arranca la cadena de asignación de staff

Rama: `claude/activity-assignment-counselors-xfnoy9`. El usuario trajo **las dos
hojas que Heather usaba**: `{Día} - Classes` y `{Día} - Care`. Lo que pidió es lo
que ninguna tabla podía guardar hasta ahora: **la lista de counselors del
encabezado de cada bloque** (`Ocean Room (K): Katelyn, LaRae & Lila`,
`Bball 3:15p-4p Courts: Fischer, Mattea, Mollie`), y que cada counselor vea sólo
lo suyo en vez de cuatro páginas resaltadas con marcador.

### El trabajo quedó partido en ocho piezas, y ésta es la 1

`daily_ops` cubre todo esto y **ya está prendido para `jccns`**, así que no hay
módulo nuevo — son tres lugares que no hubo que tocar. Las ocho piezas, en orden
de dependencia: **1 salas** · **2 catálogo de clases** · **3 reglas de care** ·
**4 motor de ruteo** · **5 asignación de staff** · **6 "Mi Día" del counselor** ·
**7 overrides por fecha** · **8 las dos hojas del lado del admin**. **Las ocho
están hechas.** Las piezas 1 y 2 se mergearon en los PR #76 y #77, y las 3 a la 6
en el #78. **`sql/37` es la única migración de toda la serie**: las demás tablas
ya existían con la forma correcta y sin puerta de entrada.

Fuera de este entregable, dicho para que no se lea como olvido: conteo de cabezas
por hora (3:00p/3:30p), `Time Out`/`Initial`, bus manifest, sign-out agrupado, el
`**` del roster, y **`LEAD`/`ASSIST` — Heather dijo que no hace falta**, son los
mismos counselors los que dan las actividades.

### Pieza 1: `rooms` deja de tener 0 endpoints

La tabla existe desde `sql/29` y tenía **0 filas, 0 endpoints, 0 UI**. **No hizo
falta migración**: sólo puerta de entrada.

| | |
|---|---|
| `server/app.py` | `GET/POST /api/admin/rooms`, `PUT/DELETE /api/admin/rooms/<id>`, más `_room_payload` y `_room_named` |
| `server/tenancy.py` | `('/api/admin/rooms', 'daily_ops')` en `MODULE_ROUTES` |
| `web/src/routes/admin/Rooms.tsx` | la pantalla, con edición inline y archivado |
| `web/src/App.tsx` · `AdminShell.tsx` | ruta `/rooms` bajo `ModuleGuard` y nav en **Program, al lado de Schools** |
| `tests/test_daily_ops_rooms.py` | **43 checks**, con DB |

### Las tres decisiones que conviene no revisar

1. **`DELETE` de una sala en uso se rechaza con 409, no cascadea.**
   `care_assignment_rules.room_id` es `ON DELETE CASCADE`, así que un DELETE
   permitido se llevaría los rangos de grado — y ésos son los que deciden dónde
   espera un chico. El camino para retirar una sala en uso es `active = false`.
   Una sala que nadie referencia sí se borra: un typo tiene que poder irse.
2. **Volver a crear una sala archivada la revive, y no la renombra.** El match
   pliega mayúsculas, así que escribir `pool` habría renombrado `Pool` en
   silencio — y ese string es lo que el counselor lee como `Pool - CARE`.
   Tampoco le borra el `capacity_hint` si el body no lo trae. Rechazar con 409
   sería un callejón sin salida: el unique hace imposible una segunda fila.
3. **El nav va en Program, al lado de Schools.** `AdminShell` imprime el título
   del grupo **antes** de filtrar los items, así que un grupo nuevo cuyos items
   estén todos detrás de `daily_ops` le deja un encabezado huérfano a todos los
   demás JCCs. Program tiene `Schools` sin módulo, así que nunca queda vacío.
   **Si alguna pieza siguiente agrega un grupo, hay que arreglar ese filtro en el
   mismo commit.**

### Verificado

`py_compile`, `tsc -b`, `npm run build`, y **los 17 scripts de `tests/` en verde
más el nuevo**, contra Postgres 16 local con `kikar_app` sin `BYPASSRLS`. Después
de `init_db()`, `rooms` tiene `organization_id`, FK, índice, `org_isolation`, RLS
forzado y `rooms_org_unique (organization_id, name)`.

Recorrido con Playwright sobre la app corriendo: agregar sala, ver el mensaje del
servidor en un nombre duplicado, archivar y revelar archivadas. Cero errores de
consola y cero respuestas 4xx en una carga limpia.

> Nota de entorno, porque cuesta media hora descubrirla: **`AUTH_OWNER_ROLE`
> tiene que apuntar a un rol con `BYPASSRLS`** (en producción `kikar_auth`). Con
> el rol dueño a secas, `auth_lookup()` devuelve **cero filas** —es
> `SECURITY DEFINER` pero el dueño también está sujeto a `FORCE ROW LEVEL
> SECURITY`— y **todo login responde "Invalid email or password"**. El rol
> además necesita `GRANT CREATE ON SCHEMA public` para poder ser dueño de la
> función. Y `pywebpush` no compila acá (`http-ece`); `app.py` ya lo tiene detrás
> de un `try/except`, así que se instala el resto de `requirements.txt` y anda.

### Pieza 2: las clases dejan de estar sin horario

Era el cuello de botella real. `class_sessions` tenía filas —el importador las
crea de las columnas M/T/W/R/F— con `start_time`, `end_time` y `location` en
**NULL**, y **sin hora de fin no se puede computar a dónde va el chico**: ni
`Dismiss To`, ni `From/To Class`, ni las piezas 4, 6 y 8. **Tampoco hizo falta
migración.**

| | |
|---|---|
| `server/daily_routing.py` | **nuevo, y puro** — sin flask ni psycopg2, como `roster_import.py`. Por ahora `parse_class_times()` más las constantes (`WEEKDAYS`, `TIME_BLOCKS`, `BLOCK_BOUNDS`, `DISMISSAL_TIMES`). El motor de la pieza 4 va en el mismo archivo |
| `server/app.py` | `GET/POST /api/admin/class-sessions`, `PUT/DELETE /api/admin/class-sessions/<id>`, y `POST .../apply-time-suggestions` |
| `server/tenancy.py` | el prefijo en `MODULE_ROUTES` |
| `web/src/routes/admin/Classes.tsx` | tabs por día, edición inline con save-on-blur, y el panel de sugerencias |
| `tests/test_daily_routing.py` | **34 checks, sin base de datos** |
| `tests/test_daily_ops_classes.py` | **56 checks, con base de datos** |

**El nombre de la clase trae la hora adentro, y eso se ofrece, nunca se
escribe.** `"Crafting 4p-4:45p"`, `"Swim L1/2 3p-3:30p"`, `"Tinker Titans
3:15p-4p"` — `parse_class_times()` los lee y la pantalla los propone con un
checkbox por fila; Heather destilda lo que esté mal y aplica. Dos barandas en el
endpoint: **sólo los ids que vinieron en el body** (un "arreglá todo" sería el
default silencioso que `sql/35` se negó a agregar) y **sólo columnas que siguen
en NULL** (una hora tipeada a mano nunca la pisa una adivinanza sobre un nombre).

Lo que el parser hace mejor que parsear es **negarse**. `"Chess"`, `"NO CLASS"`,
`"NO CLASS 6/15"` → `None`. Y `"Swim L1-2"` también, porque un rango pelado sin
`p` ni minutos es un nivel de natación, un carril o un rango de grados mucho más
seguido que una hora — leerlo como 1pm-2pm pondría una clase antes de que abra el
programa. La mitad de `test_daily_routing.py` son estas negativas.

**Borrar una clase con chicos anotados se rechaza con 409**, por lo mismo que las
salas: `class_enrollments.class_session_id` es `ON DELETE CASCADE`. Ojo con los
dos números, que no son el mismo: `enrolled_count` de la lista cuenta **chicos
activos** (un chico dado de baja conserva su inscripción — la rama `withdraw` de
`roster_staging` no la borra), y el guard del DELETE cuenta **todas** las filas,
que es lo que el cascade destruiría.

**Renombrar avisa.** `roster_staging._class_session_id` machea por nombre contra
el texto del Excel, así que renombrar hace que el próximo import **recree el
nombre viejo como una clase aparte** y parta las inscripciones en dos. El `PUT`
lo deja pasar y devuelve un `warning` que la pantalla muestra tal cual.

Dos cosas que salieron de mirar la pantalla en el navegador y no de leer el
código:

- **El resaltado ámbar del campo "Ends" no se aplicaba.** Dos utilidades de
  `border-color` en el mismo elemento las resuelve el orden de la **hoja de
  estilos**, no el del atributo `class`, así que agregar `border-sun-300` a una
  base que ya decía `border-canvas-200` perdía en silencio. Ahora el color de
  borde no está en la base: `INPUT` y `INPUT_NEEDED` son excluyentes.
- **Después de aplicar sugerencias los campos se veían vacíos.** `ClassRow`
  inicializaba su estado una vez y React reusa la instancia, así que el buffer
  local quedaba viejo: Heather aplicaba siete clases y la pantalla parecía no
  haber hecho nada. Se arregla sincronizando el buffer **durante el render**
  cuando el valor del servidor cambió — no con un `key` que remonte la fila,
  porque eso le roba el foco al campo que se está tabulando.

### Verificado (piezas 1 y 2)

`py_compile`, `tsc -b`, `npm run build`, y **los 20 scripts de `tests/` en
verde** contra Postgres 16 local con `kikar_app` sin `BYPASSRLS`. Recorrido con
Playwright de las dos pantallas: en clases, 9 sin horario → 7 sugeridas →
destildar una → "Filled in 6 classes" → el aviso baja a 3. Cero errores de
consola, cero respuestas 4xx.

### Pieza 3: el desempate de las reglas de care deja de ser un comentario

`care_assignment_rules` existía desde `sql/29` con **0 filas y 0 endpoints**.
**Tampoco hizo falta migración.** Lo que sí faltaba era más raro: la regla de
precedencia estaba **descrita en un comentario** (`server/database.py:903-907`) y
**en el banner de `sql/29:275-284`**, y no había código que la aplicara.

| | |
|---|---|
| `server/daily_routing.py` | `resolve_care_room()`, `care_candidates()`, `care_blocks()`, `grade_label()`, `grade_range_label()` — **la única** implementación del desempate |
| `server/app.py` | `GET/POST /api/admin/care-rules`, `PUT/DELETE /api/admin/care-rules/<id>`, más `_care_payload`, `_care_rules`, `_roster_grades`, `_care_conflict`, `_care_room_ok` |
| `server/tenancy.py` | el prefijo en `MODULE_ROUTES` |
| `web/src/routes/admin/CareRules.tsx` | tres tarjetas (una por bloque), tira de grados, y el editor por rango |
| `web/src/App.tsx` · `AdminShell.tsx` | ruta `/care-rooms` bajo `ModuleGuard`, nav en Program entre `Classes` y `Calendar` |
| `tests/test_daily_routing.py` | **+27 checks, sin base de datos** (61 en total) |
| `tests/test_daily_ops_care.py` | **56 checks, con base de datos** |

**El orden es el del comentario más dos escalones que no estaban.** Día
específico → rango más angosto → `priority` menor → **`id` menor**. Los dos
últimos no estaban decididos: el banner nunca dijo si `priority` alto o bajo gana
(se eligió **menor gana**, para que lea igual que `rooms.sort_order`), y no
mencionaba desempate final. El `id` **no es decoración**: la tabla no tiene
unique, así que dos reglas idénticas son posibles, y sin un orden total Postgres
puede devolverlas en cualquier orden — **el mismo día resolvería a una sala
distinta entre dos requests y el headcount se movería sin que nadie edite nada**.
Hay un check que pide la misma respuesta tres veces seguidas.

**El endpoint devuelve tres vistas de la misma respuesta**, las tres derivadas de
`resolve_care_room()` para que la pantalla no pueda mostrar una sala a la que el
motor no manda a nadie: `rules` (las filas, para editar), `blocks` (**el
encabezado de la foto, reconstruido**: `Ocean Room (K)`, `Gym (1-4)`) y `matrix`
(grado por grado, **nombrando las reglas que perdieron** — un solapamiento tiene
que verse, no descubrirse).

**Un grado sin regla se reporta, nunca se absorbe.** Grados contiguos con la
misma sala se colapsan en un rango, pero **un hueco corta la corrida**: `K` y `2`
en Ocean con nada para `1` da `Ocean (K)` y `Ocean (2)`, no `Ocean (K-2)` —
juntarlos reclamaría una sala para el único chico que no tiene ninguna. Y las
columnas son **los grados que el padrón tiene**, no un `K-4` hardcodeado.

**Dos decisiones tomadas sin respuesta de Heather**, ambas reversibles:
1. **Cada sala×bloque lleva su headcount**, rotulado *"up to N children"*. Es una
   **cota superior honesta**: cuenta a todos los inscriptos ese día cuyo grado cae
   ahí, incluidos los que están en clase parte de la hora. Está porque mover un
   rango para balancear las salas es la razón por la que ella abre la pantalla.
2. **Una sala por bloque**, aunque el encabezado de la foto diga
   `PLAYGROUND / Ocean Room (K)`. `Dismiss To` dice sólo `Ocean - CARE`, que es lo
   que el counselor lee. Si el grupo se parte de verdad es **un campo opcional en
   la regla**, nunca dos filas: dos filas duplicarían el staffing de la pieza 5.

**Acá el `DELETE` sí borra**, a diferencia de salas y clases: nada apunta a una
regla. El staff de la pieza 5 va a colgarse de (`room_id`, `time_block`) y **no**
del `id` de la regla, justamente para que mover un rango de grados no se lleve a
los counselors parados en esa sala. Sí se rechaza con 400 una regla que apunte a
una **sala archivada** — ese nombre es el destino que el counselor lee, y una
archivada imprime en blanco — y con 409 una regla **idéntica** a otra.

**Lo que salió de mirarla en el navegador y no de leer el código:** el banner de
arriba decía *"Grade K, 1, 2, 3, 4 has no room in **every block**"* incluso cuando
el hueco estaba en **un solo** bloque. El único mensaje de esta pantalla que hay
que poder creer estaba exagerando. Ahora cuenta las horas afectadas y **nombra
cuál**: *"One hour has grades with no room — 5p – 6p: grade K, 1, 2, 3, 4"*.

### Verificado (pieza 3)

`py_compile`, `tsc -b`, `npm run build`, y **los 21 scripts de `tests/` en verde**
contra Postgres 16 local con `kikar_app` sin `BYPASSRLS` (`test_tenant_isolation`
corre sus 17 checks sin avisar de superusuario, así que RLS se está probando de
verdad). Recorrido con Playwright: cargar las cinco reglas de la foto y leer los
encabezados del DOM → `Ocean Room (K) · Gym (1-4)`, `Ocean Room (K-1) · Gym
(2-4)`, `Ocean Room (K-4)` — **los tres de la foto**; borrar la regla de 5-6 y ver
el aviso del hueco; poner un override de miércoles a MPR y confirmar que gana
(con el `over 1` en la celda) y que **el lunes queda intacto**. Sin desborde
horizontal a 390px, cero respuestas 4xx, y el único 404 de consola es
`/favicon.ico`, que ya estaba.

> Nota de entorno, además de la de `AUTH_OWNER_ROLE` de más arriba: el rol de
> aplicación necesita `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` y
> `USAGE, SELECT ON ALL SEQUENCES` en `public`, más `ALTER DEFAULT PRIVILEGES`
> para las tablas que cree el dueño después. `init_db()` no los otorga — en
> Supabase se hicieron a mano — así que una base local recién creada responde
> `permission denied for table organizations` en el primer request.

### Pieza 4: el motor de ruteo — sin UI, sin endpoints, todo test

`Dismiss To` de la hoja de Classes y `From/To Class` de la de Care. La spec llama
a R2 *"the most important rule in the app"*. **Todo entró en
`server/daily_routing.py`, que sigue puro**, y en `tests/test_daily_routing.py`,
que sigue corriendo sin base de datos: **119 checks**.

| función | qué contesta |
|---|---|
| `block_of()` | en qué bloque cae una hora — **medio abierto**: las 4:00pm *abren* `4-5` |
| `dismissal_clock()` | la hora de retiro como reloj, y **`None` sigue siendo `None`** |
| `next_chained_class()` | R3: la clase que arranca exactamente cuando termina ésta |
| `dismiss_to()` | R2/R3: las tres ramas, más las advertencias |
| `care_segments()` | en qué bloques está el chico, y **la negrita de la foto** |
| `plan_day()` | las dos hojas de un día, en una sola pasada |

**Las tres ramas, en el orden que la spec dicta:** clase encadenada → `PARENTS`
si la clase termina a la hora de retiro → sala de care del (grado, bloque). **La
cadena gana incluso contra un `PARENTS` de la misma hora** — es data
contradictoria, pero la spec es explícita sobre el orden y el chico está en el
edificio igual.

**No hay cuarta rama, y eso es una decisión.** Heather confirmó que una clase
nunca termina *después* de que el chico se va; el libro de junio lo hace **cuatro
veces**. Eso es **dato malo**: se entrega a `PARENTS` —el padre ya está ahí— con
advertencia, y **nunca en silencio a care**, porque care dejaría al chico en una
sala donde el padre no está parado.

**Cinco advertencias, ninguna con fallback:** sin hora de retiro (**jamás se lee
como 6**), clase sin `end_time`, clase que termina después del retiro, ningún
rango de care que cubra el grado, y **dos clases superpuestas** (R4 permite varias
clases por día, pero dos a la misma hora es un chico en dos lugares). Un chico
**sin grado** recibe **una** advertencia y no una por bloque: la causa es la
misma, y repetirla cinco veces tapa las salas a las que de verdad les falta regla.

**La negrita no la tipea nadie.** El legend de la foto dice *"BOLD = will only be
there for part of the time due to the class they are in"*, así que es calculada:
verdadera exactamente cuando una clase le come parte del bloque. Se mide contra
el bloque y **sólo contra las clases** — irse a casa no la produce (las horas de
R1 caen justo en los bordes de los bloques, así que sólo pueden sacar bloques
enteros). Los dos casos de la foto son tests: `Swim L1/2 3p-3:30p` en `Ocean (K)`
3-4 **es** negrita, y `Mini Masters 4p-4:45p` en el mismo bloque **no**, porque su
clase es del bloque siguiente.

**`From/To Class` sale de la misma cuenta:** la clase que termina donde arranca su
rato de care es el `from`, la que arranca donde termina es el `to`. Cualquiera de
las dos puede ser `None`, que la hoja escribe `NO CLASS`.

**`plan_day()` devuelve las dos hojas juntas, a propósito.** Las piezas 6 y 8 leen
lo mismo; si cada una lo derivara por su lado, "Mi Día" del counselor y el board
del admin podrían mostrar números distintos de la misma tarde sin que ninguna se
vea mal — el mismo error que la pieza 3 evitó con el desempate.

### Pieza 5: el pedido central — quién está en cada clase y cada sala

Lo que ninguna tabla podía guardar: **la lista de counselors del encabezado de
cada bloque**. `Ocean Room (K): Katelyn, LaRae & Lila`. **La primera pieza con
migración** (`sql/37` + rollback `sql/38`, espejada idempotente en `init_db()`).

| | |
|---|---|
| `sql/37` · `sql/38` | la tabla `staff_assignments`, con cinco CHECKs y su rollback |
| `server/database.py` | el espejo idempotente **más los dos índices únicos parciales** |
| `server/tenancy.py` | `'staff_assignments'` en `TENANT_TABLES` y la ruta en `MODULE_ROUTES` |
| `server/app.py` | `GET/POST /api/admin/staff-assignments`, `DELETE .../<id>`, más `_parse_day` y `_staff_by_slot` |
| `web/src/routes/admin/StaffSchedule.tsx` | la grilla de tres bloques, con picker por slot |
| `tests/test_staff_assignments.py` | **70 checks, con base de datos** |

**Una fila es una persona en un lugar a una hora**, no un slot con una lista. Por
eso "Mi Día" de la pieza 6 va a ser un `WHERE counselor_id = yo` y no un filtro
de array en la aplicación. Mollie en `Bball` y en `Gym (2-4)` son dos filas.

**El target es (`room_id`, `time_block`), NO `care_assignment_rules.id`**, y es la
decisión que conviene no revisar. R7 dice que el corte de grados *"varies with
headcount"* y la §6.3 existe para que ella lo mueva: si el staff colgara de la
regla, cambiar `Gym (1-4)` por `Gym (2-4)` **borraría a Katelyn del Gym** — un
cambio de staffing que nadie pidió, causado por un cambio de rostering. Hay un
test que mueve el rango y verifica que la gente no se movió.

**Plantilla semanal y override por fecha en la misma tabla, con exactamente uno
de los dos seteado** (`day_of_week` XOR `assignment_date`). Los dos juntos serían
redundantes —una fecha ya sabe su día de la semana— y una columna redundante es
cómo una fila llega a contradecirse; `sql/29` se negó a agregar `children.status`
al lado de `children.active` por lo mismo. `status = 'removed'` es lo que hace
posible el override **sustractivo**: sacar a Katelyn de Ocean 3-4 un día **sin
tocar a LaRae ni a Lila**. El endpoint ya resuelve `?date=`; la pantalla es la
pieza 7.

**Los uniques no pueden ir en `PER_ORG_UNIQUES`, y esta vez se comprobó.** Esa
capa emite `UNIQUE (organization_id, cols)` **plano, sin `NULLS NOT DISTINCT`**, y
con la semántica default de Postgres dos filas que difieren sólo donde una tiene
NULL **no colisionan** — la mitad de estas columnas son nullables por diseño, así
que el constraint no deduplicaría nada mientras parecería que sí. Van como **dos
índices únicos parciales**, uno por tipo de target, creados en `init_db()` después
del pase de tenancy porque incluyen `organization_id`.

> **`assignment_date::text` no compila en un índice.** El cast DATE→TEXT lee
> `DateStyle`, así que es STABLE y no IMMUTABLE, y `to_char` tampoco alcanza. El
> par nullable se hace total con centinelas: `COALESCE(day_of_week, '')` y
> `COALESCE(assignment_date, DATE '0001-01-01')`.

**Se honró el TODO que la pieza 1 dejó escrito.** Los guards de `DELETE` de
`/api/admin/rooms/<id>` y `/api/admin/class-sessions/<id>` ahora **cuentan estas
filas**: las dos FK son `ON DELETE CASCADE`, y perder el staffing es la mitad
peor — el roster vuelve de un re-import, **las listas de counselors no existen en
ningún otro lado**, ni en el sistema ni en las planillas. El rollback de `sql/38`
lleva el `COPY` para exportarlas por nombre antes de borrar nada.

**Dos bugs propios encontrados corriendo el test:** `_STAFF_COLUMNS` sin calificar
era ambiguo en el JOIN con `users` (las dos tablas tienen `id`), y **`parse_date()`
devuelve el string que recibió y *lanza* en uno malo** — no devuelve `None`. Mi
código lo trataba como si devolviera un `date` y como si fuera falsy en el error,
así que una fecha inválida daba 500 en vez de 400. De ahí `_parse_day()`, con la
forma de `_parse_clock` que ya existía.

### Pieza 6: "Mi Día" — lo que reemplaza al marcador

R9: hoy Heather imprime **las cuatro hojas para cada counselor** y resalta a mano
los bloques de cada uno, así que todos cargan tres páginas de asignaciones ajenas
para encontrar la propia. Acá cada counselor ve **sólo sus bloques, en el orden en
que pasa la tarde**. Sin migración: se apoya entera en `sql/37` y en el motor.

| | |
|---|---|
| `server/app.py` | `GET /api/counselor/my-day`, más `_plan_for_day()`, `_child_line()` y `_clock_str()` |
| `server/tenancy.py` | `('/api/counselor/my-day', 'daily_ops')` en `MODULE_ROUTES` |
| `web/src/routes/counselor/MyDay.tsx` | la pantalla, con navegación por día |
| `web/src/App.tsx` · `AppShell.tsx` | ruta `/my-day` bajo `ModuleGuard`, tab con `modules: ['daily_ops']` |
| `tests/test_my_day.py` | **37 checks, con base de datos** |

**El filtro es el `counselor_id` del token, y no hay parámetro que lo cambie.** Un
test manda `?counselor_id=<otro>` en la query string y verifica que la respuesta no
se mueve. Otro test confirma que Katelyn y Fischer reciben tardes distintas.

**`_plan_for_day()` es el helper que la pieza 8 va a reusar sin filtrar por
persona.** Lee las columnas de clase **crudas**, no por `_CLASS_COLUMNS`: ése
formatea las horas como `'HH:MM'` para las pantallas de edición, y el motor las
compara como valores de reloj.

**Un chico ausente se marca, no se borra, y no se cuenta.** Borrarlo deja a un
counselor buscando a alguien que está en la casa; contarlo hace que el headcount
mienta. Van al final de la lista, atenuados, con su pill.

**Las alergias viajan en cada fila.** Es el único campo que cambia lo que hace el
adulto que está ahí, y nadie debería tener que salir de la lista que tiene en la
mano para encontrarlo.

**La negrita de la hoja de Care no podía ser negrita.** El nombre del chico ya
está en bold por defecto en esa lista, así que el subconjunto-de-la-hora se marca
con **subrayado**; el cue tenía que ser otro para seguir siendo un cue.

**Las advertencias se filtran a los chicos propios.** La pantalla de un counselor
no es la lista de los problemas de datos de otro.

### Dos cosas que el test corrigió, y no eran del código

1. **Un chico que se va a las 4 no está en el bloque de 4 a 5.** Yo esperaba a Dan
   en el Gym de 4-5 porque es de 2º grado como Cara; el motor lo saca porque su
   retiro es a las 4. Tiene razón: una lista que lo incluyera dejaría a un
   counselor esperando a un chico que el padre ya se llevó. Quedó como aserción.
2. El chico ausente que yo puse en 1º grado caía en el **Gym**, no en Ocean, por
   la regla `Gym (1-4)`. La regla resolvió bien; la expectativa estaba mal.

### Verificado (pieza 6)

`py_compile`, `tsc -b`, `npm run build`, y **los 23 scripts en verde**. Recorrido
con Playwright a 390px **entrando como counselor de verdad** (hubo que ponerle
password a una cuenta demo: `seed_demo.py` las crea sin poder iniciar sesión):
el tab "My day" aparece, los bloques salen en orden (`Gym` 3-4 care → `Bball`
3:15 → `Ocean Room` 4-5), la línea `With Josh Kaplan` en la clase compartida, los
ausentes atenuados y al final, el `**` de la cadena en `Crafting 4p-4:45p`, y
**"Ask the office — no destination"** en los chicos sin hora de retiro — que es
justo lo que el motor tiene que hacer en vez de inventar. Sin desborde horizontal,
cero 4xx, y el 404 de consola sigue siendo `/favicon.ico`.

### Piezas 7 y 8: el que se reporta enfermo, y las dos hojas generadas

**Ninguna de las dos necesitó migración.** La 7 es UI sobre un schema que ya la
soportaba; la 8 es `_plan_for_day()` sin filtrar por persona.

| | |
|---|---|
| `server/app.py` | `GET /api/admin/daily-board`, y `_staff_by_slot()` ahora devuelve `(in_effect, stood_down)` |
| `server/tenancy.py` | `('/api/admin/daily-board', 'daily_ops')` |
| `web/src/routes/admin/StaffSchedule.tsx` | modo **Every week** / **One day** |
| `web/src/routes/admin/DailyBoard.tsx` | las dos hojas, con pestañas |
| `web/src/App.tsx` · `AdminShell.tsx` | ruta `/daily-board`, nav en **Operations** (no en Program: es la pantalla desde la que se corre la tarde) |
| `tests/test_staff_assignments.py` | +6 checks del override resuelto (76) |
| `tests/test_daily_board.py` | **34 checks, con base de datos** |

**El hueco que había que tapar antes de escribir la pantalla:** `_staff_by_slot`
calculaba el set de `removed` y **lo tiraba**. Sin devolverlo no hay vuelta atrás
— una lista resuelta simplemente no los tiene, así que una baja hecha por error
era imposible de deshacer desde la pantalla que la hizo. Y dar de baja a alguien
es exactamente la acción que se hace apurado. Ahora cada slot trae `out_today`, y
la pantalla los muestra tachados con un botón de deshacer **en la misma tarjeta**.

**En modo fecha, sacar a alguien no es un DELETE.** Escribe una fila `removed`
para ese día y deja la plantilla intacta, que es lo mismo que deja a sus dos
compañeros en el bloque. Un DELETE lo sacaría de **todos** los lunes de la
temporada: la misma acción con dos significados muy distintos, así que el `aria-label`
y el tooltip los distinguen, y el botón de agregar dice **"Cover"** en vez de
**"Add"**.

**La 8 genera las dos hojas de la §3.5 y la §3.6** con sus encabezados de bloque
(nombre, hora, lugar, staff), el `Dismiss To`, la columna `From/To Class`, la
negrita y el headcount. Un test **compara los dos endpoints directamente** en vez
de razonar que coinciden: el `Dismiss To` del board y el del teléfono del
counselor que tiene al chico salen del mismo `_plan_for_day`.

Fuera de la 8, dicho para que no se lea como olvido: los conteos periódicos de la
§3.6, `Time Out`/`Initial` de la §3.5, el bus manifest y el sign-out. Los dos
primeros necesitan una tabla de eventos de asistencia — `attendance_records` es
una fila por chico por día, no varias.

### Tres cosas que salieron de mirarlo en el navegador

1. **El banner del board repetía el mismo mensaje 12 veces** sin decir de qué
   chico. El motor emite una advertencia por chico, así que doce chicos sin hora
   de retiro daban doce oraciones idénticas: largo como para parecer completo e
   inservible para actuar. Ahora agrupa por código y **nombra a quién**: *"10 no
   pickup time on file — Adam Serfaty, Daniel Benhamu, … and 2 more"*. Pasó de 20
   líneas a 4.
2. **Cambiar a "Every week" y volver perdía la fecha.** El modo y la fecha eran un
   solo valor nullable, así que volver reseteaba a hoy — y comparar una tarde
   contra la plantilla es la única comparación para la que existe esa pantalla.
   Ahora son dos estados separados.
3. **Usé `decoration-berry-400`, que no existe** — exactamente el modo de falla
   que documenté abajo, dos piezas después de arreglarlo. Vale insistir: **un
   token que falta no rompe nada visiblemente, sólo cae a `currentColor`.**

### Verificado (piezas 7 y 8)

`py_compile`, `tsc -b`, `npm run build`, y **los 24 scripts en verde**. Recorrido
con Playwright: en la plantilla semanal, dar de baja a la persona del template
para **un** lunes → aparece tachada con el botón de deshacer, el bloque queda
"Nobody assigned" → volver a **Every week** y **sigue estando** → deshacer y
vuelve. En el board, las dos pestañas con sus tablas, los avisos agrupados, los
ausentes atenuados y al final, y los nombres subrayados de los que están parte de
la hora. Sin desborde horizontal a 390px, cero 4xx, y el único 404 de consola
sigue siendo `/favicon.ico`.

### El bug de color que estaba en tres pantallas

Mirando la pantalla en el navegador, el borde de "nobody assigned" salía **negro**
en vez de ámbar. La causa no era esta pieza: **siete tokens se usaban y no
existían** en `theme.css` — `sun-200/300/400/700`, `berry-200/700`, `leaf-700`.
Tailwind emite la utilidad sólo para un token declarado, así que `border-sun-300`
sobre un elemento que además decía `border-2` no generaba regla de color y el
borde caía a `currentColor`. **Afectaba también a las piezas 2 y 3** y a
`CounselorSchools`, `ReleaseChild` y `SchoolAttendance`: todo banner de
advertencia de la app tenía contorno negro y su texto en color heredado.

Se arreglaron **las rampas, no los call sites** — `theme.css` es el único lugar
del que puede salir un color. Ojo con este modo de falla: **un token que falta
falla en silencio y justo en la dirección que parece deliberada.**

### Verificado (pieza 5)

`py_compile`, `tsc -b`, `npm run build`, y **los 22 scripts en verde**. Después de
`init_db()`, `staff_assignments` tiene `organization_id`, FK, índice,
`org_isolation`, RLS forzado, los cinco CHECKs y los dos uniques parciales.
Recorrido con Playwright: cargar tres personas en `Bball` y dos salas de care,
confirmar que **quien ya está asignado desaparece del picker**, sacar a uno y ver
que **los otros dos siguen ahí**, que el martes no heredó nada y que el lunes
siguió intacto. Sin desborde horizontal a 390px, cero respuestas 4xx, y el único
404 de consola sigue siendo `/favicon.ico`.

### Verificado (pieza 4)

`py_compile`, `tsc -b`, `npm run build`, y **los 21 scripts en verde**. El test
carga un lunes armado con las clases reales del libro (`Bball 3:15p-4p`,
`Crafting 4p-4:45p`, `Mini Masters 4p-4:45p`, `Tinker Titans 3:15p-4p`,
`Swim L1/2 3p-3:30p`) más las cinco reglas de care de la foto, y compara
`Dismiss To` **fila por fila**: la cadena Bball→Crafting por nombre, Tinker→
`PARENTS`, Swim→`Ocean Room`, Crafting→`Gym`. Después el mismo lunes con los
cuatro errores de dato y las advertencias que tienen que salir. **Sin pantalla ni
endpoints**: es la pieza con más reglas y la única que se prueba entera sin base,
y mezclarla con una UI es cómo los casos raros dejan de probarse.

### Lo que sigue

La **pieza 3, las reglas de care**: día × bloque × rango de grados → sala, que es
el paréntesis del encabezado de la foto (`Ocean Room (K)`, `Gym (1-4)`). La tabla
existe desde `sql/29` con 0 filas y 0 endpoints, y **la resolución de
solapamientos sigue escrita sólo en un comentario** (`database.py:903-907`): día
específico → rango más angosto → `priority`. Va implementada en
`daily_routing.py` para que se pueda testear sin base, y tiene que ser **la
única** copia, o dos pantallas van a mostrar números distintos.

---

## Sesión del 2026-08-04 (clases) — el primer corte de la fase 2a

Rama: `claude/jccsn-daily-operations-spec-rjhwu0`, encima de la sesión de infra
de más abajo. Los pasos **1 y 2 de la §6.1**: el catálogo de clases existe, y el
importador dejó de tirar los nombres que ya leía.

### Qué se agregó

| | |
|---|---|
| `sql/35_add_class_sessions.sql` | `class_sessions` + `class_enrollments`, con rollback `sql/36` |
| `server/database.py` | las dos tablas espejadas en `init_db()` |
| `server/tenancy.py` | las dos en `TENANT_TABLES`, y sus dos uniques en `PER_ORG_UNIQUES` |
| `server/roster_staging.py` | `_apply_registrations` las escribe; `_class_session_id` es nuevo |

**`class_sessions`** — identidad `(name, day_of_week)`: "Chess" el lunes y
"Chess" el miércoles son dos filas, porque pueden tener horas, sala y roster
distintos. `start_time` / `end_time` / `location` / `capacity` son **nullables**,
y eso es lo que más importa de esta migración.

**`class_enrollments`** — `child_id` + `class_session_id`. El día no se repite
acá: vive en la clase, así que los dos no pueden desincronizarse. Un chico con
dos clases el mismo lunes son dos filas, que es justo el caso para el que
existe el encadenado.

### Por qué las horas quedan vacías (y por qué está bien)

**El roster no las trae.** Las columnas M/T/W/R/F dicen `Soccer 3:15p-4p` como
texto libre, o directamente `Chess` — no hay campo de hora. Así que el
importador puede *crear* el catálogo pero no puede completarlo.

Inventar un `end_time` es la opción peligrosa, no la cómoda: R2 compara el fin
de clase contra la hora de retiro, y un fin equivocado manda al chico a una sala
de care donde el padre no está parado. La §6.3 pide una **advertencia** —
*"child with no computable destination"*— precisamente para este caso, y el NULL
es lo que la hace posible. **Poner un default acá habría reemplazado una
advertencia por una respuesta incorrecta.**

Consecuencia directa, y hay que decirla fuerte: **el motor de `Dismiss To`
todavía no puede computarse.** Falta la pantalla donde Heather carga las horas.

### Lo que se decidió NO construir

- **`season`.** La §6.1 dice "class catalog (per season)", pero nada más en el
  schema sabe qué es una temporada — `registrations` tampoco tiene — así que una
  columna contra la que ningún código puede filtrar es andamiaje.
- **El encadenado.** Se deriva de las horas; guardarlo sería una segunda fuente
  de verdad capaz de contradecir a la primera.
- **Una columna `source`** que separe filas del roster de las cargadas a mano.
  El commit reemplaza las inscripciones del chico enteras, igual que ya hacía
  con `registrations`. Si algún día las ediciones manuales tienen que sobrevivir
  a un re-import, ese es el cambio, y merece su propia decisión.

### Verificado

`sql/35` aplica, `sql/36` revierte, y `sql/35` de nuevo dos veces seguidas sin
error. Después de `init_db()`, las dos tablas tienen `organization_id`,
`org_isolation`, RLS forzado, y los uniques reescritos por organización:
`UNIQUE (organization_id, name, day_of_week)` y
`UNIQUE (organization_id, child_id, class_session_id)`.

Aserciones nuevas en `test_roster_staging.py`, sobre el caso que ya estaba en el
fixture y nadie usaba: **Juniper Birch tiene dos filas de miércoles**, una con
`Soccer 3:15p-4p` y otra con `Floor Hockey 4p-4:45p`. R4 las funde en un chico, y
las clases tienen que sobrevivir esa fusión como **dos** inscripciones en vez de
que gane la última. Eso, más que reimportar el mismo archivo no duplica ni el
catálogo ni las inscripciones, más que el otro JCC no ve ninguna de las dos
tablas.

**16 de 17 scripts de `tests/` en verde.** El que falla es `test_password_reset.py`
y **no es de este cambio**: falla idéntico con el trabajo guardado en `git stash`,
7 aserciones sobre redimir un token de reset. Queda anotado como preexistente,
sin arreglar, porque es otro problema.

> Nota de entorno: los `.sql` de `sql/` no corren contra una base local tal
> cual — hacen `CREATE POLICY ... TO anon, authenticated` y esos roles son de
> Supabase. Localmente las tablas las crea `init_db()`. Para validar el archivo
> entero alcanza con `CREATE ROLE anon NOLOGIN` y `authenticated` en la base de
> desarrollo. Lo mismo `AUTH_OWNER_ROLE`, que dos tests exigen y el `.env` de
> ejemplo no trae: apuntarlo a un rol `BYPASSRLS` (en producción es `kikar_auth`).

### Lo que sigue

Lo de 2a que queda es **endpoints y pantallas**, no schema:

1. **CRUD de `class_sessions`** — sin él las horas no se cargan y R2 no computa.
   Es lo próximo, y lo bloquea todo lo demás.
2. **`rooms` y `care_assignment_rules`** siguen con **0 endpoints, 0 UI y 0 filas**
   en producción. Los pasos 3 y 4 de la §6.1 son exponer lo que ya está.
3. Recién con 1 y 2 el motor de `Dismiss To` tiene contra qué correr.

---

## Sesión del 2026-08-04 (infra) — se cierra la brecha entre lo reportado y lo verificado

Rama: `claude/jccsn-daily-operations-spec-rjhwu0`. Sesión de **verificación contra
producción** con Supabase CLI, Render CLI y `psql`. **Cero escrituras en
producción:** cada consulta corrió con `SET default_transaction_read_only = on`
dentro de `BEGIN READ ONLY`. Lo único que cambia en el repo es `docs/`.

Las tres coordenadas del handoff siguen vigentes: servicio
`kikar-afterschool-tunz` / `srv-d9n3krtaeets73b5ecr0`, proyecto Supabase
`trxnvcrjyqkbmbobjkys` (us-east-2, `ACTIVE_HEALTHY`, Postgres 17.6).

### El chequeo que valida a todos los demás

```
 current_user | rolbypassrls | rolsuper
 kikar_app    | f            | f
```

`DATABASE_URL` apunta a `kikar_app.trxnvcrjyqkbmbobjkys` en
`aws-0-us-east-2.pooler.supabase.com:5432` — **session mode**, como pide
`CLAUDE.md`. Sin `BYPASSRLS` y sin `SUPERUSER`, así que todo lo que sigue sobre
aislamiento se probó de verdad y no por privilegio.

**Y quedó demostrado de paso, sin buscarlo.** La primera corrida de
`SELECT ... FROM organizations` devolvió **0 filas**. No es que no existan: es
`org_self` haciendo su trabajo sobre una conexión sin contexto. Con
`set_config('app.is_superadmin','on')` —lo mismo que hace `database.py:198`—
aparecen las dos. *Si alguna sesión futura ve cero organizaciones, ese es el
motivo; no concluya que la base está vacía.*

`ADMIN_DATABASE_URL` y `DATABASE_URL` **siguen siendo idénticas** (riesgo 9 del
08-02, todavía abierto).

### Parte 1 — la organización existe, y el combo está completo

**La duda queda cerrada: existe, y con `daily_ops` prendido.**

| id | slug | name | timezone | creada |
|---|---|---|---|---|
| 1 | `kikar` | Kikar Afterschool | America/New_York | 2026-08-01 18:56 |
| 2 | `jccns` | JCCNS | America/New_York | **2026-08-03 19:43** |

Los ocho módulos que `jccns` tiene escritos en su `modules` (jsonb):

| módulo | jccns | esperado |
|---|---|---|
| `daily_ops` | **true** | on ✓ |
| `secure_pickup` | true | on ✓ |
| `pickups` | false | off ✓ |
| `check_in_out` | true | on ✓ |
| `photos` | true | on ✓ |
| `parent_messaging` | true | on ✓ |
| `activities` | true | — |
| `late_arrivals` | true | — (toggle sin código detrás, riesgo 4) |

**El combo pedido está completo.** Las otras ocho claves del catálogo no están
en el jsonb y **eso no es un problema**: `module_enabled()`
(`server/tenancy.py`) cae al default declarado en `MODULES` cuando la
organización "no tiene opinión". O sea `absences` / `recurring_absences` /
`messages` / `calendar` / `time_off` / `push` quedan **on** por default, y
`makeup_classes` / `two_factor` **off**. `kikar` tampoco tiene `daily_ops` en su
jsonb, así que le vale `False` — que es lo correcto.

**Sí tiene admin.** Crear la organización no dejó al JCC sin puerta de entrada:

| id | org | email | password_set |
|---|---|---|---|
| 28 | jccns | `moisesbenzaquen23@gmail.com` | **true** |
| 3 | kikar | `campsoltaplin@marjcc.org` | false |

### El hallazgo que ningún documento anticipaba: el roster real ya está cargado en producción

El handoff del 08-03 describe la corrida del importador **"en una org local
descartable"**. Esa misma corrida ya está en Supabase, sobre `jccns`, commiteada
por el usuario 28 el **2026-08-03 22:52 → 23:07**:

| | |
|---|---|
| archivo | `J Adv Fall Roster 2026-27 (1).xlsx` |
| batch | 1, estado `committed` |
| filas leídas | 221 → 157 chicos, 62 de borrador, 2 de leyenda |
| resultado | **156 creados, 1 bloqueado**, 0 unchanged, 0 withdrawn |
| cuentas de padre | 125 creadas, **0 con contraseña puesta** |

Y lo que hay hoy en las tablas de `jccns`:

| tabla | filas |
|---|---|
| `children` | 156 (todos `active = 1`) |
| `schools` | 5 |
| `registrations` | 379 |
| `child_contacts` | 310 (156 de prioridad 1, 154 de prioridad 2) |
| `child_compliance` | 1001 |
| `school_aliases` | 6 |
| `users` | 127 (1 admin, 1 counselor, 125 padres) |
| `rooms` | **0** |
| `care_assignment_rules` | **0** |

Reparto por escuela — **idéntico al de la corrida local**: Brown 69, Glover 43,
SPS 36, EHS 4, Village 4. Horas de retiro: 4:00 PM 136, 5:00 PM 229, 6:00 PM 14,
**ningún 3:00** (la pregunta abierta sigue en pie). Por día: lunes 74, martes 83,
miércoles 85, jueves 83, viernes 54.

`scripts/verify_roster.py --org jccns` corre limpio contra producción y agrega
tres cosas para mirar:

- **1 nombre de escuela sin resolver: `????`** — es la fila bloqueada, `J Adv
  Roster` fila 72, grado 3, flag `HG: Waiting on Paperwork`.
- **59 chicos activos no están inscriptos en ningún día** — no aparecen en
  ninguna vista derivada, board ni headcount. (97 sí tienen al menos un día.)
- **1 chico sin fecha de nacimiento** — el del año cortado. 155 de 156 la tienen.

Eso reconcilia una diferencia que si no confunde: el parser reportó los flags
como 45 / 30 / **11** / 1, y `children` en producción da 45 / 30 / **10** / 1.
La que falta es exactamente la fila bloqueada.

### Parte 2 — `sql/29`, `sql/31` y `sql/33` aplicaron, y las policies están puestas

**El sanity check del propio archivo devuelve las 7 filas, todas
`rls_enabled = true`:**

```
 care_assignment_rules | t      rooms                 | t
 child_compliance      | t      roster_import_batches | t
 child_contacts        | t      roster_import_rows    | t
 school_aliases        | t
(7 rows)
```

Y —la parte que el `.sql` **no** pone y que dependía de que el servicio
rebooteara— las 7 tienen `organization_id`, `org_isolation` y `FORCE ROW LEVEL
SECURITY`. **Las siete, sin excepción.** No hay agujero de aislamiento entre
JCCs. Se explica: el último deploy es `dep-d9ov8doae00c73doc24g`, commit
`e7530d5`, **live el 2026-08-04 14:16 UTC**, o sea muy posterior a la migración
del 08-03, así que `init_db()` volvió a correr con las 7 tablas ya en
`TENANT_TABLES`.

El resto de la parte 2, punto por punto:

| chequeo | resultado |
|---|---|
| `registrations.dismissal_time` | **existe**, `smallint`, nullable |
| las 13 columnas nuevas de `children` | **las 13**, con los tipos del `.sql` |
| `sql/31` — `attendance_records.status/_at/_by/_note` | las 4 ✓ |
| `sql/33` — `counselor_schools.effective_from/_to/assigned_by/_at` | las 4 ✓ |
| `sql/33` — tabla `counselor_school_changes` | existe, RLS on, `org_isolation` ✓ |
| RLS sobre todo `public` | **43 de 45** tablas |

Las 2 sin RLS son `app_settings` y `login_attempts` — las mismas dos de siempre,
declaradas a propósito en `GLOBAL_TABLES`. La cuenta subió de 36 tablas (08-02)
a 45 por `sql/29` + `sql/33`.

**Conclusión para la próxima sesión: `sql/29` aplicó. El corte de
`class_sessions` + `class_enrollments` (`sql/35`/`36`) no está bloqueado.**

### Parte 3 — Render: qué sigue pendiente, con nombres exactos

Hoy hay **17** variables en el servicio (el 08-02 decía 18), y el plan sigue en
**`free`**.

| | estado |
|---|---|
| `SEED_TEST_ACCOUNTS=1` | **prendido — y probado que funciona** |
| `RESEND_API_KEY` | **falta** → no sale ningún mail |
| `EMAIL_FROM` | falta → cae a `EMAIL_USER` (también sin setear) → `noreply@jclubapp.com` |
| plan | `free` → cada SSE muere a los ~15 min de idle |
| claves VAPID | **no faltan — ver corrección abajo** |
| `DEMO_MODE` | sin setear ✓ |

**Lo de las cuentas de prueba dejó de ser teórico.** Un `POST /api/auth/login`
contra el servicio real con `testcounselor@jclub.com` / `Test1234!` devolvió
**HTTP 200 con token, rol `counselor` y la organización 1 entera en el
payload**. `password_set_at` está en NULL en esas dos filas, pero eso solo marca
"el usuario todavía no eligió su propia clave" — el hash es
`bcrypt.hashpw('Test1234!')` (`server/seed_test_data.py:45`), así que la
contraseña publicada en el repo entra. En la base viven además las 21 cuentas
`@demo.kikarlabs.com` del seed de demo, todas en la organización 1.

### Parte 4 — el 403 de módulos, **verificado en vivo** (y sin tocar ningún toggle)

No hizo falta apagar nada: la organización 1 ya tiene `pickups` **off** y
`secure_pickup` **on**, así que un solo token prueba las dos direcciones. Todo
con el token de `testcounselor@jclub.com` (org 1) contra
`https://kikar-afterschool-tunz.onrender.com`:

| endpoint | módulo | estado en org 1 | HTTP | cuerpo |
|---|---|---|---|---|
| `/api/counselor/pickup-alerts` | `pickups` | off | **403** | `This feature is not enabled for your organization` |
| `/api/admin/school-aliases` | `daily_ops` | off | **403** | `This feature is not enabled for your organization` |
| `/api/admin/roster-import` | `daily_ops` | off | **403** | `This feature is not enabled for your organization` |
| `/api/counselor/authorized-pickups` | `secure_pickup` | **on** | 400 | `child_id is required` |
| `/api/admin/admins` | *(ninguno)* | — | 403 | `Unauthorized` |
| `/api/counselor/pickup-alerts` *(sin token)* | — | — | 401 | — |

**Lo que hace la prueba concluyente son las dos últimas filas.** El 403 de
módulo y el 403 de rol traen **mensajes distintos**, así que el rechazo se
puede atribuir al módulo y no a una coincidencia con el chequeo de rol. Y el
400 del cuarto renglón prueba la dirección positiva: con el módulo prendido la
request **llega al handler** y falla por su propio parámetro faltante.

Que `daily_ops` también dé el 403 de módulo con un token de counselor sale de
que el enforcement vive en un `before_request` (`server/app.py:458` y
siguientes), que corre **antes** que el decorator de rol.

**El riesgo 2 del 08-02 y el punto 1 de "Próximos pasos" quedan cerrados.**

### Lo que estaba mal en los documentos, y quedó corregido

1. **La organización "reportada creada, sin confirmar"** — el bloque del 08-04
   (spec) ahora dice lo que se verificó. Existe, con `daily_ops` on y admin.
2. **"Claves VAPID → sin push" (riesgo 8) es falso.** `_load_or_create_vapid_keys()`
   (`server/app.py:275`) prefiere las variables de entorno, y **si no están las
   busca en `app_settings`, y si tampoco están las genera y las guarda**. En
   producción hay `vapid_public_key` (87 chars) y `vapid_private_key` (43), y
   `GET /api/push/vapid-public-key` devuelve **200** con una clave P-256 válida.
   `pywebpush==2.0.1` está en `requirements.txt`. **Push está configurado.** Lo
   que hay es **0 filas en `push_subscriptions`**: falta que alguien se
   suscriba, no que falte la llave. Poner las variables sigue siendo deseable
   —para que la llave no dependa de una tabla— pero no es lo que traba el push.
3. **`EMAIL_FROM` sí existe como variable**, aunque no aparezca en un `grep`
   ingenuo: la llamada se parte en dos líneas (`server/app.py:715-718`). La
   cadena es `EMAIL_FROM` → `EMAIL_USER` → `noreply@jclubapp.com`. El handoff
   tenía razón; se anota porque el grep de una línea miente acá.

### Un agujero que no estaba anotado: `/upload` no tiene `ModuleGuard`

El guardrail dice que la pantalla del importador legacy está oculta cuando
`daily_ops` está prendido. **Está oculta, pero solo el ítem del menú:**

- `web/src/components/AdminShell.tsx:106` — `{ to: '/upload', … unless: 'daily_ops' }`
- `web/src/App.tsx:101` — `['/upload', <AdminUpload />]` — **sin `ModuleGuard`**,
  y es la única ruta admin de un módulo que no lo tiene.
- `/api/admin/upload-roster` **no está en `MODULE_ROUTES`** a propósito: es el
  importador core que usan los demás JCCs.

O sea que un admin del JCCNS que llegue a `/app/upload` por URL o por bookmark
encuentra la pantalla vieja funcionando, y el endpoint la acepta. Y esa pantalla
ejecuta `UPDATE children SET active = 0` **sin `WHERE`** (`server/app.py:3457`);
RLS lo acota a su organización, que hoy son **los 156 chicos del JCCNS**, y
después reactiva solo lo que venga en el archivo. Un archivo truncado da de baja
al programa entero.

Es exactamente el riesgo 3 del 08-02 al revés —esconder el nav no protege la
ruta— y era la única defensa que tenía el guardrail.

**Arreglado en esta sesión.** `ModuleGuard` acepta ahora `unless`, la misma
llave que ya usaba el nav de `AdminShell`, así que las dos capas se leen igual:

```tsx
['/upload', <ModuleGuard unless="daily_ops"><AdminUpload /></ModuleGuard>],
```

Con `daily_ops` on la ruta deja de renderizar el importador y manda a
`/roster-import`, explicando por qué. **Es solo cliente**, a propósito: el
endpoint es core y los demás JCCs lo necesitan, así que mandarlo a
`MODULE_ROUTES` habría requerido una regla "off cuando otro módulo está on" que
el modelo actual no expresa. Si algún día se quiere defensa en profundidad, ese
es el trabajo. `tsc -b`, `npm run build` y `tests/test_module_access.py`, en
verde.

### Las cuentas de prueba: apagadas ✅ (autorizado y ejecutado)

De las cuatro escrituras que esta sesión dejó listas, se autorizó y se hizo
**una**, la urgente:

1. `SEED_TEST_ACCOUNTS` pasó de `1` a **`0`** en el servicio.
2. Se borraron las dos filas `@jclub.com`. `org 1`: usuarios 24 → 22, chicos
   27 → 25. Las 21 cuentas `@demo.kikarlabs.com` y los 25 chicos de la demo
   quedaron intactos, y `jccns` no se tocó (156 chicos antes y después).
3. **Verificado:** `POST /api/auth/login` con `Test1234!` devuelve ahora **401
   `Invalid email or password`** para las dos cuentas. `/`, `/app/` y
   `/api/push/vapid-public-key` siguen en 200.

### ⚠️ La trampa del redeploy era peor de lo documentado: `render restart` NO recarga el entorno

El handoff del 08-02 decía que después de cambiar variables por la API "hay que
reiniciar el servicio a mano (`render restart <id>`)". **Eso no alcanza, y esta
sesión lo comprobó de la peor manera:** con la variable ya en `0` y las filas
borradas, un `render restart` **volvió a crear las dos cuentas** — reaparecieron
con ids nuevos (157 y 158) y el login volvió a dar 200.

`render restart` reinicia el contenedor **con el entorno que ya tenía**. Lo que
materializa una variable cambiada es un **deploy**:

```
render deploys create srv-d9n3krtaeets73b5ecr0 --confirm --wait
```

Recién con `dep-d9p338bncjis73evssfg` (live 18:39 UTC) el proceso levantó con
`SEED_TEST_ACCOUNTS=0`, y ahí sí el borrado quedó. **El orden importa: primero
el deploy, después el borrado.** Al revés, el arranque re-siembra lo que
acabás de borrar.

### Las tres escrituras que quedan — listadas, no ejecutadas

1. **`RESEND_API_KEY`** + **`EMAIL_FROM`** con un dominio verificado
   post-rebrand. Sin la primera no sale un solo mail. Hace falta la key.
2. **Plan `free` → `starter`**, antes de entregar.
3. Opcional: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` con los valores que ya
   están en `app_settings`, para que dejen de depender de esa tabla.

Las tres necesitan el mismo `deploys create` de arriba para tomar efecto.

### Lo que sigue

Sin cambios respecto del plan: **§6.1 pasos 1–2**, `class_sessions` +
`class_enrollments` como `sql/35` con rollback `sql/36`, espejado en `init_db()`
y registrado en `TENANT_TABLES`, más que `_apply_registrations`
(`server/roster_staging.py:459`) deje de descartar los nombres de clase.
`sql/29` aplicó, así que **nada de eso está bloqueado**.

Dos cosas que esta sesión agrega a esa lista: `rooms` y `care_assignment_rules`
están **vacías** en producción (0 filas), o sea que los pasos 3 y 4 de la §6.1
no tienen ni datos ni endpoints todavía; y los **59 chicos sin ningún día**
van a caer fuera de toda vista derivada cuando el motor exista — conviene que
Heather los mire antes, no después.

---

## Sesión del 2026-08-04 (spec) — llega la §6, y el plan se reordena

Rama: `claude/jccsn-daily-operations-spec-rjhwu0`. **Sesión de documentación:
ni una línea de código, ni schema, ni migración.** `git diff --stat` toca
`docs/` y nada más.

### Qué cambió en el spec

`jccsn-daily-ops-spec.md` recibió una sección nueva, la **§6 — Admin
configuration & UI views**, y las preguntas abiertas pasaron a ser la **§7**.
La §6 trae tres cosas:

- **§6.1** — las **ocho cosas que Heather configura**, en orden de dependencia
  (catálogo de clases, inscripciones, salas, reglas de care, staff, plantilla
  semanal, overrides por fecha, rutas de bus), con la afirmación de que una vez
  que existen esas ocho el motor deriva todo lo demás solo.
- **§6.2** — la pantalla "My Day" del counselor, y **dónde se dispara el
  sign-out**: desde el bloque de clase (chicos con `Dismiss To: PARENTS`) *y*
  desde el bloque de care. El §3.7 describía una hoja; esto describe dónde se
  toca.
- **§6.3** — el tablero del admin: las siete pestañas del libro **más** cuatro
  cosas que ninguna hoja tenía — headcount en vivo por regla de care,
  advertencias, overrides en cascada y board de estado en vivo.

### El renumerado rompía cuatro referencias

Cuatro lugares decían "§6 del spec" queriendo decir *las preguntas abiertas*.
Todos apuntaban a la sección equivocada después del cambio, y todos están
corregidos a §7: `build-plan.md` (dos), este archivo (el bloque de acá abajo) y
`source-files-analysis.md`.

### Tres cosas que se verificaron en el código, y que reordenaron el plan

1. **El importador parsea los nombres de clase y los tira.**
   `ParsedRegistration.classes` se llena en `server/roster_import.py` desde las
   columnas M/T/W/R/F, pero `_apply_registrations`
   (`server/roster_staging.py:459`) los usa **solo** para decidir si escribe la
   fila de `registrations` — y después no los guarda en ningún lado. Con la
   §6.1 paso 2 eso deja de ser aceptable: es el primer arreglo de la fase 2a.
2. **`rooms` y `care_assignment_rules` ya están en la base** desde `sql/29`,
   espejadas en `init_db()` y registradas en `TENANT_TABLES`, con **cero
   endpoints y cero UI** (`grep` sobre `app.py` da 0 en las dos). Los pasos 3 y
   4 de la §6.1 son exponer lo que ya existe, bastante más barato de lo que
   decía el plan.
3. **`activity_schedules` no puede hacer de `ClassSession`.** Ata por *patrón de
   nombre* en vez de por id, y tiene `dropoff_time`/`pickup_time` pero no
   `end_time` ni `location`. Sin `end_time` la R2 no se puede computar, así que
   el paso 1 de la §6.1 necesita tabla nueva igual.

### Cómo quedó el plan

`build-plan.md` tenía la fase 2 como una lista de las siete hojas del §3. La
§6.1 dice que las hojas son la *salida*, no la entrada, así que la fase quedó
partida en tres: **2a** la configuración (las ocho, con el estado real de cada
una), **2b** las siete vistas (la tabla de antes, intacta, ahora explícitamente
río abajo de 2a) y **2c** lo que agrega la §6.3 y el Excel no tenía. La fase 3
suma lo de la §6.2 sobre el sign-out.

De las cinco preguntas de la §7, una ahora bloquea algo concreto: **los cupos
(pregunta 5)** son el `capacity` del catálogo de clases, y sin respuesta la
advertencia *"clase pasada de cupo"* de la §6.3 no tiene contra qué comparar.
El campo se construye opcional para no esperarla.

### La cuarta rama de R2 se cierra — y estaba cerrada hace rato

Heather respondió: **una clase nunca termina después de la hora de retiro.** R2
queda con dos ramas y el motor con tres. Dos cosas que salieron al anotarlo:

1. **`build-plan.md` la daba por abierta sin estarlo.** `source-files-analysis.md`
   ya la tenía tachada y resuelta a `→ PARENTS`; el build-plan la seguía listando
   como bloqueante de la fase 0 y como *"falta acordar"* dentro de la fase 2.
   Los dos documentos decían cosas distintas del mismo tema. Ahora dicen lo
   mismo, y la fase 0 baja de tres preguntas a dos — queda solo **de dónde salen
   los chicos de las 3:00**.
2. **El libro de junio contradice la regla cuatro veces.** El cruce sobre
   `M - Classes` dio 59 filas conformes y 4 con el fin de clase posterior al
   retiro (tres a `PARENTS`, una a `Gym - CARE`). La regla dice que no pasa; el
   archivo dice que pasó. Se resuelve tratándolo como **dato malo, no como
   ruteo**: `PARENTS` de fallback —lo que ella hizo en 3 de los 4— **más
   advertencia** en el tablero de la §6.3. Nunca care en silencio, que es lo que
   devolvería la lógica de la §4 sin esta decisión: un chico esperando en una
   sala a la que el padre no lo fue a buscar.

**El hallazgo de las 4 filas no se borró de ningún documento a propósito.** Es la
evidencia de que la validación hace falta; si se borra, la próxima sesión
construye el motor sin ella.

### La organización del JCCSN — ~~reportada creada, sin confirmar~~ ✅ VERIFICADA

> **Corregido el 2026-08-04 por la sesión (infra) de más arriba.** Lo que sigue
> es lo que esta sesión pudo afirmar en su momento; la verificación real está
> en la sesión de infra y contradice la parte de "sin confirmar", no el resto.
>
> **Existe** (`jccns`, id 2, creada el 2026-08-03 19:43), tiene **`daily_ops`
> on** más `secure_pickup` on / `pickups` off / `check_in_out` / `photos` /
> `parent_messaging`, y **tiene admin** (`moisesbenzaquen23@gmail.com`, con
> contraseña puesta). De hecho el roster real ya está commiteado adentro: 156
> chicos, 5 escuelas, 379 registrations.

El usuario reporta que **ya está creada** (la lista de *Próximos pasos* del 08-03
todavía la daba por pendiente desde el 08-02). Queda anotado como reporte, **no
como hecho verificado**: este entorno no tiene `DATABASE_URL` ni credenciales de
superadmin, y no existe ninguna ruta pública que liste organizaciones —
`GET /api/superadmin/organizations` (`server/superadmin.py:78`) exige JWT de
superadmin.

**Lo que queda por confirmar es el toggle, no la existencia:** sin `daily_ops`
prendido, el importador que ya está construido responde 403 y su pantalla ni
aparece en el menú del admin. Chequear en `/app/organizations` que la org tenga
`daily_ops` on, más el combo del handoff (`secure_pickup` on, `pickups` off).

### Lo que sigue

El primer corte de código es la **§6.1 pasos 1–2**, y ahora **sin nada que lo
bloquee**: `class_sessions` + `class_enrollments` como `sql/35` con su rollback
`sql/36`, espejado en `init_db()`, registrado en `TENANT_TABLES`, más que
`_apply_registrations` deje de descartar los nombres de clase. Eso destraba el
motor de `Dismiss To`, del que cuelga todo el §3 y la §6.2–6.3.

---

## Sesión del 2026-08-04 (build) — el portal del counselor, partido en dos

Rama: `claude/canceller-portal-attendance-release-v99nsb`. **Cambio solo de
front-end: ni una ruta nueva, ni una columna nueva, ni una migración.** Lo que
se guarda del lado del admin (hora de llegada al tildar, hora de salida + firma
al liberar) es exactamente lo de antes; lo que cambió es dónde se hacen esas
dos cosas.

### El problema

`/today` imprimía **todos los chicos de todas las escuelas en una sola
columna**, y cada fila traía un botón *Release*. Dos trabajos compartiendo una
lista, y a ninguno le servía: quien está parado en la puerta de Brown tiene que
scrollear las otras tres escuelas para encontrar su renglón, y *Release* — que
es lo que pasa horas después, en la puerta del JCC, con la firma del padre —
estaba sobre la pantalla cuyo único propósito es marcar quién se subió.

### Cómo quedó

| Pantalla | Ruta | Para qué |
|---|---|---|
| Today | `/today` | La **lista de escuelas**, no de chicos. Cada tarjeta: nombre, cuántos hay adentro, barra de avance y un pill `Submitted` / `N left`. |
| Attendance de una escuela | `/today/:schoolId` | Los chicos **de esa escuela sola**, tilde por chico, el control de estados, y una barra pegajosa con **Submit**. Cero botones de Release. |
| Pickup | `/pickup` | Quién está en el edificio, **con buscador por nombre y apellido**. Se toca al chico y se abre ahí mismo el flujo de release (quién lo retira → firma). Abajo, "Picked up today" con la hora de salida. |

- La ruta de la escuela cuelga de `/today` a propósito: el botón *atrás* del
  teléfono sale de la escuela y cae en el día, que es lo que espera alguien que
  terminó en una puerta.
- La tab **Pickup** aparece solo con `secure_pickup`, y la ruta va envuelta en
  `ModuleGuard` como todas las demás.
- El buscador matchea por prefijo de **cualquier** parte del nombre y pliega
  acentos: "ben" encuentra a Benjamin Cohen y "cohen ben" también.

### Qué significa Submit (y qué no)

**Cada tilde se sigue guardando sola, en el momento.** Eso es lo que evita que
un teléfono que se muere a mitad de la fila se lleve la tarde puesta, y es lo
que mantiene vivo el board del admin. Submit agrega el **final del trabajo**:
escribe `on_bus = 0` para los que nunca se tildaron, que es lo que convierte
una escuela a medio marcar en una escuela contestada.

De ahí sale el pill: **"Submitted" es derivado, no guardado** — una escuela
está lista cuando no le queda ningún chico sin registro del día. Por eso no
hizo falta ninguna columna nueva, y por eso el pill no puede mentir.

Dos cuidados que están en el código y conviene no perder:

- Submit **solo toca a los que no tienen registro**. Un chico marcado
  `not_found`, `absent` o `issue` ya tiene fila, así que Submit no le pisa el
  estado.
- Si no hay **nadie** marcado ni nadie que se haya ido, Submit **pregunta dos
  veces** antes de escribir "no se subió nadie" sobre el padrón entero. Si ya
  hubo retiros, no pregunta: la escuela evidentemente se trabajó.

### De paso

`web/src/lib/roster.ts` es nuevo y junta lo que estaba duplicado entre Today y
Roster (tipos del roster, las dos queries y la mutación optimista, ahora también
en lote). Los tipos ya habían derivado entre las dos copias — la de `Roster.tsx`
venía sin `release_group` ni `parent_email`.

También: la tarjeta de la cola de pickups ya no dibuja un empty state del
tamaño de una card cuando no hay nadie esperando; el encabezado ya lo dice, y
esa card empujaba las escuelas abajo del pliegue.

### Verificado corriendo la app

Postgres local + `scripts/seed_demo.py` (4 escuelas, 25 chicos) y un counselor
sin asignación — o sea, ve las cuatro. Recorrido con Playwright: tildar cuatro
chicos en Hillel y Submit → 4 filas con `checked_in_at` y 3 con `on_bus = 0`;
buscar "toledano" en Pickup → firmar → `pickup_releases` con firma y
`checked_out_at` en la fila de asistencia, y el chico se mueve solo a "Picked
up today". El camino de confirmación se probó en Temple Beth Am.

**Los 13 scripts de `tests/` en verde** (los dos sin DB y los once contra una
base local con rol sin `BYPASSRLS`), más `py_compile`, `tsc -b` y el build.

---

## Sesión del 2026-08-03 (build) — pasos 1 a 3 de la fase 1

Rama: `claude/jccsn-app-setup-dj4x9h`, sobre el análisis de más abajo. Acá sí se
escribió código. Un paso por commit, PR al terminar cada uno.

| # | Commit | Qué |
|---|---|---|
| 1 | `58b2dcc` | Se declara el módulo `daily_ops` y se corrige el padrón a 157 |
| 2 | `2ac0bef` | El schema donde aterriza el roster: `sql/29` + rollback `sql/30`, espejado en `init_db()` y registrado en `tenancy.py` |
| — | `b526975` | Arreglo aparte: `test_tenant_isolation.py` no podía crear las organizaciones que testea |
| 3 | *este* | El parser: `server/roster_import.py` + `tests/test_roster_import.py` |

### Paso 3 — el parser, y por qué es puro

`server/roster_import.py` no importa flask, ni psycopg2, ni `database.py`, y hay
una aserción en el test que lo verifica. Toma valores de celda y devuelve
dataclasses. Eso es lo que hace que el preview que Heather aprueba y lo que
después se commitea salgan **del mismo parseo** (guardado en
`roster_import_rows`), en vez de parsear el archivo dos veces y confiar.

Lo que resuelve, todo verificado contra los archivos reales:

- **Columnas por nombre de encabezado, nunca por índice.** Dos razones
  independientes: el mapa del spec está corrido desde la `U` (`complete` es AD,
  no AC), y la hoja `No Longer` tiene 34 columnas en otro orden, con los días
  como letras sueltas (`M T W R F`, donde `R` es jueves), un espacio de más en
  `' R - Class'` y `Pick up (pg 3)` en vez de `(pg 2)`.
- **Una fila es un chico si `School` tiene valor Y no es renglón de leyenda**
  (sin coma en el nombre, sin contacto y sin DOB). Corta las 62 filas de
  borrador y los 2 renglones de leyenda sin cortar por número de fila.
- **R4**: las filas duplicadas se funden por nombre + escuela + grado; la primera
  fila gana los escalares, las demás aportan solo clases y lo que quedó vacío.
  Un desacuerdo de hora entre dos filas se **reporta**, no se resuelve.
- **Nada se descarta en silencio.** Cada celda ilegible deja un Notice con el
  número de fila del Excel que Heather tiene abierto.

### La corrida contra el archivo real — cuadra con el análisis

221 filas leídas → **157 chicos**, 62 de borrador, 2 de leyenda, 0 bloqueados,
**60 sin ningún día inscripto**, contactos completos en 155 y uno solo en 2.
Los flags de la columna A dan exactamente `SG: New` 45 / `SG: REMOVE` 30 /
`HG: Waiting` 11 / `SG: Returning` 1. Horas de retiro: 5 (229), 4 (136), 6 (14)
y **ningún 3** — la pregunta abierta sobre el grupo de las 3:00 sigue en pie.

La lógica de fusión y el `**`, que el roster no puede ejercitar (0 duplicados),
se cruzaron contra las hojas de día del libro de asistencia: **6, 5, 12, 10 y 0
filas fundidas** de lunes a viernes, igual que el análisis. El jueves da 9
marcas y no 10 — que es justo el olvido de carga a mano ya documentado.

**Todo el archivo entra con 5 avisos**, y los cinco son cosas que una persona
tiene que mirar: un DOB con el año cortado, un `??` en Bus, un `????` de
escuela, dos contactos sin nombre (se usa el mail o el teléfono, no se pierden)
y dos celdas de `Medication` que traen el nombre del remedio. Los dos últimos
hallazgos son nuevos → preguntas 8 y 9 del análisis.

### De paso: el mismo bug de RLS en el otro test

`test_module_enforcement.py` tenía idéntico defecto al que se arregló en
`test_tenant_isolation.py`: creaba organizaciones sin ventana de superadmin
(`org_self` tiene `WITH CHECK (is_superadmin='on')` y `FORCE ROW LEVEL SECURITY`
alcanza al dueño), así que **no corría**; y su `DELETE` de limpieza no tenía
organización pineada, así que borraba cero filas y las tres orgs `t-` sobrevivían
cada corrida, tapado por el `ON CONFLICT DO UPDATE`. Arreglado igual, con una
aserción nueva de que la limpieza limpia.

**Estado de los tests: los cuatro en verde, dos corridas seguidas, 0 filas `t-`
dejadas atrás.**

### Paso 4 — los endpoints de import, y la puerta de entrada que faltaba

`server/roster_staging.py` (la mitad que habla con la base; el parser sigue
puro) + siete rutas finas en `app.py`, todas detrás del módulo `daily_ops`:

```
POST   /api/admin/roster-import              sube y stagea, no toca children
GET    /api/admin/roster-import              últimos lotes
GET    /api/admin/roster-import/<id>         la pantalla de revisión
POST   /api/admin/roster-import/<id>/commit  recién acá se escribe
DELETE /api/admin/roster-import/<id>         descartar
GET    /api/admin/school-aliases             las escuelas del archivo
PUT    /api/admin/school-aliases/<id>        resolver una a mano
```

**Tres restricciones del schema mandaron el diseño.** `children.parent_id` y
`children.school_id` son `NOT NULL`, y `users.email` es único en toda la
plataforma. O sea que un chico no existe sin padre y sin escuela:

- **Las escuelas se crean solas desde el roster.** Una organización nueva no
  tiene ninguna; exigirlas de antemano obligaría a Heather a tipear a mano los
  nombres que el archivo ya trae. Solo un *placeholder* —`????`, sin una sola
  letra— queda para que lo conteste una persona. Contra el archivo real: se
  crearon Brown, EHS, Glover, SPS y Village, y quedó `????`.
- **Las cuentas de padre se crean, pero no se manda un solo mail.** Contact #1
  es el `parent_id`. Las cuentas quedan con una clave inservible y sin acceso;
  invitar a 126 familias es una decisión que alguien toma a propósito con el
  job de invitaciones, no un efecto secundario de tocar Importar.
- **Una fila a la que le falta cualquiera de los tres queda `blocked`**, con su
  número de fila, y se saltea en el commit. Las otras entran igual.

**Corrida completa contra el archivo real de Heather**, en una org local
descartable: 157 parseados → **156 creados, 1 bloqueado** (el del `????`),
125 cuentas de padre, 31 hermanos compartiendo, 379 registrations, 310
contactos, 1001 filas de cumplimiento, 155 con fecha de nacimiento (la que
falta es la del año cortado). Reparto por escuela: Brown 69, Glover 43, SPS 36,
EHS 4, Village 4. **Volver a subir el mismo archivo: 156 `unchanged`, cero
duplicados.** Y `password_set_at` en 0 cuentas, o sea que nadie puede entrar
todavía.

### La puerta de entrada de una organización nueva

`POST /api/superadmin/organizations/<id>/admins` (+ el `GET`). Crear una
organización dejaba un JCC **sin ninguna forma de entrar**: `/api/admin/admins`
toma la organización del token del que llama, y `require_admin()` es igualdad
exacta con `'admin'`, así que un superadmin no puede usar las pantallas de
admin para arrancar el JCC de otro. La única vía era un INSERT a mano.

No se setea ni se devuelve contraseña: la cuenta queda con un hash aleatorio
inservible y la respuesta trae un `setup_url` de un solo uso, válido 7 días.
Se devuelve en vez de mandarse por mail a propósito — es la primerísima cuenta
de un JCC, normalmente antes de que su SMTP esté configurado.

### Lo que sigue

Paso 5: la pantalla de revisión en la SPA, que hoy no existe — el import
funciona por API pero no tiene UI.

Y el arreglo de `forgot-password`, que va **en un PR aparte**: hoy la ruta hace
`SELECT * FROM users` sin organización pineada, RLS lo esconde, y **ningún
usuario de ningún JCC puede recuperar su contraseña**.

Sigue pendiente lo de siempre: `DATABASE_URL` / `ADMIN_DATABASE_URL` como
variables de entorno **en una sesión nueva** y el acceso de red al pooler de
Supabase, sin lo cual el roster no se puede cargar en la organización JCCNS.

---

## Sesión del 2026-08-03 — el spec de Heather y los archivos reales del JCC

Rama: `claude/jccsn-app-setup-dj4x9h`. **No se escribió código de aplicación**,
a propósito: la sesión era de análisis y plan.

### Estado del proyecto

- La app está **deployada y sirviendo** en `afterschool.kikarlabs.com` (ver
  sesión del 2026-08-02: schema en Supabase, RLS verificada en vivo, 4 de 5
  módulos del JCC construidos).
- Ahora existen las tres piezas que faltaban para planificar: el **spec
  funcional** del walkthrough con Heather
  ([`jccsn-daily-ops-spec.md`](./jccsn-daily-ops-spec.md) — fuente de verdad de
  las reglas de negocio), los **archivos reales** con los que el programa se
  maneja hoy (en `docs/source-files/`, fuera de git), y el **plan de build**
  ([`build-plan.md`](./build-plan.md)).
- **Toda sesión arranca leyendo este handoff y el spec.**

### Qué se hizo hoy

1. **Llegaron los dos Excel** — el roster de otoño 2026-27 y el paquete de
   asistencia de la semana del 15-19 de junio. Quedaron en `docs/source-files/`.
2. **`docs/source-files/` está en `.gitignore`**, junto con `*.xlsx`, `*.xls` y
   `*.csv`. Tienen nombre, DOB, alergias, medicación y teléfono de **menores
   reales**; no se commitean nunca. Verificado con `git check-ignore`. No había
   ninguna planilla trackeada de antes, así que la regla no tapa nada.
3. **Se inspeccionaron los dos libros con `openpyxl`** →
   [`source-files-analysis.md`](./source-files-analysis.md): estructura, conteos
   y valores categóricos, **sin una sola fila de datos**.
4. **Llegó el spec** y se contrastó contra los archivos, regla por regla.
5. **Se verificó R6 contra el código** (abajo).
6. Se escribió **`build-plan.md`**: schema §4 contra las 33 tablas existentes,
   y cuatro fases — importador → vistas derivadas → vista del counselor →
   portal del padre — cada una con qué valida Heather.

### El cruce spec ↔ archivos, en cinco líneas

Detalle completo en el análisis; lo que cambia decisiones:

- **El mapa de columnas del spec (§1) está corrido una columna desde la `U`**
  (el propio spec lista 10 nombres para un rango de 9). Un importador literal
  leería `complete` como *Contact #1*. → Resolver por encabezado, nunca por
  índice.
- **R2 verificada sin una sola violación** en 59 filas reales — pero hay un
  cuarto caso (retiro *antes* del fin de la clase, 4 chicos) que el spec no
  contempla.
- **El `**` de R3 cuadra numéricamente** (`**` = 2 × filas duplicadas en 4 de 5
  días) y la negrita de care está decodificada (`BOLD = will only be there for
  part of the time...`). **Los dos son derivables** — no hay que importarlos.
- **El roster tiene dos bloques en una hoja**: 157 chicos + 62 filas de borrador
  + 2 renglones de leyenda con escuela puesta. **El padrón es 157, no 159.**
- **30 chicos dicen `SG: REMOVE`** en la columna que el spec manda ignorar.
  **Resuelto: se ignora**, y no cuesta nada — los 30 están entre los 60 sin
  ningún día inscripto, así que no aparecen en ninguna vista derivada igual.
- **Los archivos son de cohortes distintas** (otoño 2026-27 vs junio 2026):
  validan reglas, no datos.

### R6 — verificada, ya se cumple

> Sign-out solo en dispositivos del staff con captura de firma; los padres nunca
> firman la salida desde su teléfono. **Requisito duro para toda decisión de
> arquitectura futura.**

`POST /api/counselor/pickup/release` (`server/app.py:4935`) devuelve 403 a
cualquier rol que no sea counselor o admin, la firma es obligatoria en servidor
y en cliente, se guarda en `pickup_releases.signature` (BYTEA), y del lado del
padre solo existe la administración de la **lista de autorizados**. Detalle y
líneas en el análisis.

**La trampa:** `secure_pickup` viene apagado por default. Con el módulo en
`False` no hay flujo de sign-out ninguno. La org del JCC necesita
`secure_pickup` **on** y `pickups` **off**.

### Próximos pasos

1. **Fase 0 del plan: cerrar con Heather las tres preguntas que bloquean el
   importador** — `SG: REMOVE`, el retiro anterior al fin de clase, y los chicos
   de las 3:00 que no están en el roster. Veinte minutos de llamada.
2. ~~**Crear la organización del JCCSN** en `/app/organizations`~~ ✅ **hecha el
   2026-08-03** y verificada el 08-04: `jccns` (id 2), con el combo completo más
   `daily_ops` on.
3. **Pedir a Heather el roster con las columnas de clase cargadas** apenas
   existan los signups de otoño — sin eso las fases 2-3 no se prueban de verdad.
4. Recién entonces, **fase 1: el importador** (`build-plan.md` §2).
5. Sigue pendiente todo lo operativo del 08-02: SMTP/VAPID, free→starter,
   apagar `SEED_TEST_ACCOUNTS`, probar el 403 de módulos en vivo.

### Preguntas abiertas

Del §7 del spec (rastrear acá, como pide el propio spec):

1. Lista exacta de códigos de escuela y sus nombres completos (Brown, Glover,
   SPS, EHS, Village, D.O. — confirmar).
2. Natación (Swim L/T, Pvt Swim) — ¿se modela como clase con instructor externo?
   ¿Mismas reglas de dismissal?
3. El documento de "pickup locations" (mapa clase → sala para padres) — conseguir
   la versión final 2026-27.
4. Retiro tarde / late fee — Heather mencionó padres evitando el cargo; ¿entra
   en scope el tracking?
5. ¿Cupos por clase y por sala?

Y las que salieron del cruce con los archivos reales — las tres de la fase 0
arriba, más ocho menores listadas al final de
[`source-files-analysis.md`](./source-files-analysis.md) (paperwork pendiente,
escuelas basura, `Brown - Drop Off`, grado `0` vs `K`, `Online`, viernes sin
sign-out, dos contactos fijos, hermanos).

---

## Sesión del 2026-08-02

Estado: todo en `main` (`fd32950`), pusheado y **deployado**. La rama
`claude/project-changes-yesterday-5fiqx4` quedó en `1899a88`, dos commits atrás;
**trabajá sobre `main`**.

Complemento de [`jccns-scope.md`](./jccns-scope.md), que cubre *qué* hay que
construir. Esto cubre *en qué estado quedó* y dónde están las trampas.

> **Actualizado al cierre del 2026-08-02.** La primera versión de este documento
> se escribió antes del deploy y decía que nada había corrido nunca contra una
> base de datos. Eso dejó de ser cierto veinte minutos después. Lo verificado
> desde entonces está marcado ✅ abajo.

---

## Coordenadas — leer antes de tocar infraestructura

| | |
|---|---|
| Repo | `kikarlabs-code/kikar-afterschool` (privado), default `main` |
| Servicio Render | **`kikar-afterschool-tunz`** · `srv-d9n3krtaeets73b5ecr0` |
| URL pública | **https://afterschool.kikarlabs.com** |
| URL directa de Render | https://kikar-afterschool-tunz.onrender.com — sigue viva, útil para probar salteando el DNS |
| Proyecto Supabase | `trxnvcrjyqkbmbobjkys` ("Kikar Afterschool", us-east-2) |
| Bucket de fotos | `photos`, privado |

### Datos de demo en producción

La organización 1 (`kikar`) tiene un programa completo cargado para poder mirar
la app con algo adentro: 4 escuelas, 18 familias, 25 chicos, 30 días de
asistencia con concurrencia despareja, 6 actividades con 126 entradas de roster
—un cuarto sin counselor a propósito, para que "needs a counselor" y la
asignación masiva tengan sobre qué actuar—, 7 make-up classes futuras, 40
personas autorizadas a retirar, 5 conversaciones y 6 fotos en el bucket.

Lo genera [`scripts/seed_demo.py`](../scripts/seed_demo.py). Es idempotente y
todo lo que escribe está marcado; para sacarlo:

```sql
DELETE FROM users WHERE email LIKE '%@demo.kikarlabs.com';
```

**Las 21 cuentas que crea no se pueden usar para entrar** — el hash es bcrypt de
un salt aleatorio, así que `checkpw` devuelve False para cualquier contraseña en
vez de romper. Verificado: da 401, no 500.

**Se prendieron todos los módulos de la org 1** para que ninguna pantalla dé
403. Antes estaban `pickups`, `calendar` y `makeup_classes` apagados. Si esta
org va a ser la del JCCNS y no una demo, hay que volver a su combo real
(`pickups` off; `secure_pickup` / `check_in_out` / `photos` / `parent_messaging`
on).

### El dominio

`afterschool.kikarlabs.com`, agregado el 2026-08-02. El DNS de `kikarlabs.com`
vive en **Vercel** (`ns1/ns2.vercel-dns.com`), no en el registrador: el registro
es un CNAME `afterschool` → `kikar-afterschool-tunz.onrender.com`, TTL 60.

Hay un wildcard `*.kikarlabs.com` que apunta a Vercel, así que **cualquier
subdominio de kikarlabs.com resuelve aunque no exista**. El CNAME específico le
gana al wildcard. Si algún día `afterschool` empieza a servir el landing de
Vercel en vez de la app, lo primero que hay que mirar es si ese CNAME
desapareció y el wildcard volvió a atrapar el nombre.

El certificado lo emite Render solo (Google Trust Services) unos minutos después
de verificar el dominio. En el medio el puerto 80 ya redirige a HTTPS pero el
handshake TLS falla — es normal, no hay nada que arreglar, hay que esperar.

### Por qué el servicio se llama `-tunz` y no `kikar-afterschool`

`render.yaml` declara `name: kikar-afterschool`, y el servicio real se llama
`kikar-afterschool-tunz`. La discrepancia tiene explicación y **no hay que
"arreglarla"**:

1. **17:57** del 2026-08-01 se creó un servicio `kikar-afterschool` a mano, sin
   el blueprint. Quedó con `gunicorn app:app` (el módulo es `server.app`) y sin
   el paso de `npm run build`; su único deploy falló con `ModuleNotFoundError`.
2. **18:26** se aplicó el Blueprint. El nombre ya estaba tomado, así que Render
   —que ante una colisión no falla, agrega un sufijo aleatorio— creó
   `kikar-afterschool-tunz`.

Ese servicio a mano **se eliminó el 2026-08-02**, así que hoy queda uno solo y
el nombre `kikar-afterschool` está libre. Se documenta igual porque durante un
día el repo apuntó a un servicio muerto: `render.yaml` nombraba
`kikar-afterschool`, `deploy.md` daba su URL como ejemplo de `ALLOWED_ORIGINS`,
y ningún documento decía dónde estaba deployado de verdad. Alguien siguió esas
migas hasta el servicio equivocado y concluyó que nada funcionaba —
exactamente al revés de la realidad.

**No renombres el servicio ni cambies `name:` en `render.yaml` para que
coincidan.** Tocar el nombre en el blueprint hace que Render cree un servicio
*nuevo* en vez de renombrar el existente, y volverías a tener dos. La
discrepancia es cosmética; lo que importa es que el ID de arriba sea el único
lugar donde se busca.

---

## Contexto en una línea

El JCC North Shore es el primer cliente y tiene una lista de features cerrada.
Esta sesión auditó qué existía, convirtió los features nuevos en **módulos
vendibles por organización**, y construyó cuatro de los cinco.

El modelo de negocio manda sobre la arquitectura: **nada se elimina**. El flujo
viejo de pickup sigue entero; al JCCNS se le apaga y se le prende el nuevo.
Otro JCC compra el viejo.

---

## Qué se hizo

Nueve commits, `8cd322d` → `fd32950`. 36 archivos, +4389 / −217.

| Commit | Qué |
|---|---|
| `8cd322d` | Auditoría del scope JCCNS → `docs/jccns-scope.md` |
| `37340b5` | 5 módulos nuevos + **enforcement server-side** + test que lo cuida |
| `d9e84a8` | `check_in_out` — horas de entrada/salida, headcount en vivo |
| `c408690` | `secure_pickup` — lista de autorizados, confirmación de entrega |
| `3871232` | `parent_messaging` — conversación en dos vías |
| `76f4322` | `photos` — galería privada por familia sobre Supabase Storage |
| `1899a88` | Doc de scope actualizado |
| `1ab1a0b` | Moderación de fotos para admin + fix de conexiones del pool |
| `fd32950` | Este documento |

### El cambio que más importa entender

`module_enabled()` existía en `server/tenancy.py` y **no lo llamaba ningún
endpoint**. Los toggles solo escondían pantallas: cualquiera con un token
válido pegaba al endpoint de un módulo que su JCC no compró y recibía los
datos. Mientras los módulos eran una preferencia de UI daba igual. Ahora que
son la lista de precios, no.

Hoy `tenancy.MODULE_ROUTES` mapea cada ruta a su módulo y un `before_request`
en `app.py` devuelve 403. Es una tabla en un solo lugar, no un decorator en
cada una de las ~70 rutas, para que el límite de facturación se lea de una sola
vista y `tests/test_module_access.py` lo pueda auditar.

---

## Dónde está cada cosa

**Backend**
- `server/app.py` — el hook de módulos, `module_on()`, y todos los endpoints
  nuevos. Sigue siendo un solo archivo, sin blueprints.
- `server/tenancy.py` — `MODULES`, `MODULE_ROUTES`, `module_for_path()`, y las
  6 tablas nuevas en `TENANT_TABLES`.
- `server/database.py` — las tablas nuevas en `init_db()`.
- `server/photo_storage.py` *(nuevo)* — toda la dependencia con Supabase
  Storage aislada en tres funciones, a propósito: si algún día se muda a S3,
  este archivo es el radio de explosión.

**Migraciones** — `sql/19` … `sql/26`, cada `add` con su `rollback`.
**Aplicar la 19 antes que la 21**: el release escribe `checked_out_at`.

**Tests**
- `tests/test_module_access.py` *(nuevo)* — falla si una ruta `/api` queda sin
  decisión de módulo. **No necesita base de datos**, corrélo siempre.
- `tests/test_tenant_isolation.py` — caso nuevo: un padre no ve las fotos de
  otra familia **dentro del mismo JCC**.

**Frontend** — pantallas nuevas: `admin/Conversations`, `admin/Photos`,
`counselor/Photos`, `parent/Photos`; componentes `AuthorizedPickup` y
`ReleaseChild`; `lib/useHeadcountStream.ts`, `lib/image.ts`; y `lib/api.ts` que
ahora sabe mandar `FormData`.

---

## Riesgos y bugs conocidos

### 1. ~~Nada corrió contra una base de datos~~ ✅ RESUELTO
Era el riesgo grande y ya no existe. El código se escribió sin Postgres en el
contenedor, pero **el deploy corrió y `init_db()` aplicó todo**. Verificado
contra Supabase el 2026-08-02:

- Las 6 tablas nuevas existen: `authorized_pickup_people`, `pickup_releases`,
  `parent_threads`, `thread_messages`, `photos`, `photo_tags`.
- `attendance_records` tiene `checked_in_at` y `checked_out_at`.
- RLS activo en **34 de 36** tablas. Las 2 sin RLS son `app_settings` y
  `login_attempts`, y está bien: el rate-limiting de login tiene que funcionar
  *antes* de que exista una sesión, así que no puede depender del contexto de
  organización.

**Y el aislamiento quedó probado en vivo, de casualidad.** Una consulta como
`kikar_app` sin contexto de organización devuelve cero filas en `users`,
`children` y `schools`, aunque el planner reporta 1 organización, 1 escuela,
2 chicos y 4 usuarios. La policy está haciendo su trabajo:

```
org_self: current_setting('app.is_superadmin') = 'on'
          OR id = current_setting('app.organization_id')
```

Confirmado también: `kikar_app` tiene `rolbypassrls = false`, y `DATABASE_URL`
apunta al pooler en **session mode** (puerto 5432), no al de transacciones — o
sea que `LISTEN/NOTIFY` funciona y el pickup en vivo no está roto por transporte.

### 2. ~~El 403 de módulos nunca se probó en vivo~~ ✅ RESUELTO el 2026-08-04
Verificado contra el servicio real en la sesión (infra) del 08-04, y sin tocar
ningún toggle: la organización 1 ya tenía `pickups` off y `secure_pickup` on.
`/api/counselor/pickup-alerts` → **403** *"This feature is not enabled for your
organization"*; `/api/counselor/authorized-pickups` → 400 *"child_id is
required"*, o sea que llega al handler. `daily_ops` da el mismo 403 en
`/api/admin/roster-import` y `/api/admin/school-aliases`. El 403 de rol dice
*"Unauthorized"* — mensaje distinto, así que el rechazo es atribuible al módulo.
Tabla completa arriba.

### 3. Pantalla que llama a un endpoint sin `hasModule` → 403
Apareció **cuatro veces** en una sola sesión: `Account.tsx` (2FA),
`counselor/Schedule.tsx` (actividades), `admin/Dashboard.tsx` y
`counselor/Today.tsx` (pickups). Los cuatro arreglados. Es la trampa número uno
de este código: cualquier pantalla nueva que pida un endpoint gateado sin
preguntar primero se come un 403 — y varios módulos vienen apagados por
default, así que se rompe para *todos* los JCCs, no para un caso raro.

### 4. `late_arrivals` es un toggle que no hace nada
Está en el catálogo y aparece en la consola superadmin, pero **no tiene una
sola línea de código detrás**. Si alguien se lo vende a un JCC, lo prende y no
pasa nada. `test_module_access.py` lo lista en cada corrida como "módulo sin
rutas". O se construye o se saca del catálogo hasta entonces.

### 5. Fotos: objeto huérfano posible
Storage y Postgres no se pueden hacer atómicos. El orden elegido —subir, luego
las filas en una transacción, y borrar el objeto si las filas fallan— puede
dejar un archivo sin fila si el proceso muere justo en el medio. Cuesta
storage. Al revés dejaría una foto que el padre sigue viendo después de que el
counselor la borró, que es peor. Además `sql/26` **no vacía el bucket**:
exportá `storage_path` antes de correrlo.

### 6. Render free duerme a los ~15 minutos
Cada SSE abierto muere ahí: la cola de pickups y el headcount nuevo. Hay que
pasar a starter antes de entregar.

### 7. ~~Cuentas de prueba — CONFIRMADO prendido en producción~~ ✅ RESUELTO el 2026-08-04
`testparent@jclub.com` / `testcounselor@jclub.com` con `Test1234!` en texto
plano en `server/seed_test_data.py`, y los emails siguen en `@jclub.com` tras
el rebrand. **`SEED_TEST_ACCOUNTS=1` estaba puesto en el servicio real**, y el
08-04 se comprobó que la contraseña entraba (HTTP 200 con token). Hoy la
variable está en `0`, las dos filas están borradas y el login da **401**. Ver la
sesión de infra del 08-04, incluida la trampa del `restart` vs `deploy`.
(`DEMO_MODE` no está seteado.)

### 8. Faltan variables de entorno en Render
Sobre el servicio `-tunz`, hoy hay 18 variables. Faltan:

- **`RESEND_API_KEY`** → **no sale ningún mail**: invitaciones y reset de
  password fallan para el usuario final. Ojo con el nombre: el proveedor por
  default es `resend`, no SMTP (`app.py:508`). La ruta SMTP existe pero hay que
  pedirla con `EMAIL_PROVIDER=smtp`, y usa `EMAIL_USER` / **`EMAIL_PASS`** —
  no `EMAIL_PASSWORD`.
- `EMAIL_FROM` → el default es `noreply@jclubapp.com`, dominio anterior al
  rebrand.
- ~~Claves VAPID → sin push.~~ ❌ **ESTO ESTABA MAL** — corregido el 2026-08-04.
  `_load_or_create_vapid_keys()` (`server/app.py:275`) cae a `app_settings` y,
  si tampoco están ahí, **las genera y las guarda**. En producción existen las
  dos y `GET /api/push/vapid-public-key` devuelve 200 con una clave P-256
  válida. Push **está configurado**; lo que hay es 0 filas en
  `push_subscriptions`. Setear las variables sigue siendo deseable para no
  depender de esa tabla, pero no es lo que traba el push.

~~`BASE_URL`~~ ✅ ya está en `https://afterschool.kikarlabs.com`. Se anota lo que
era porque el modo de fallar es feo y silencioso: sin ella vale
`http://localhost:5000` (`app.py:519`) y **todo link de invitación y de reset
sale apuntando a localhost**, sin ningún error en el log. Estuvo latente hasta
hoy solo porque no había proveedor de mail configurado.

### 9. `DATABASE_URL` y `ADMIN_DATABASE_URL` son idénticas
[`CLAUDE.md`](../CLAUDE.md) pide dos roles: uno dueño para `init_db()` y uno sin
privilegios para los requests. Hoy las dos variables tienen exactamente el mismo
valor (`kikar_app`).

**No es un agujero de aislamiento** porque `tenancy.py` aplica
`FORCE ROW LEVEL SECURITY`, que hace que las policies apliquen incluso al dueño
de las tablas — sin ese `FORCE`, sí lo sería, porque un dueño de tabla bypassea
RLS por default. Pero la separación de privilegios que el diseño pedía no
existe: cualquier bug de SQL injection corre con permisos de DDL.

### No son bugs — que nadie los "arregle"
- `/api/parent/stream` **no** está gateado a propósito: transporta la
  confirmación de asistencia, que es core, no un módulo.
- Los warnings `jsx-key` de `App.tsx` son un falso positivo de oxlint: esos
  elementos se pasan como `element={...}` a `<Route>`, no se renderizan como
  array. Crecen de a uno por cada ruta nueva.

### Arreglados en `1ab1a0b`
- **El admin no podía moderar fotos.** Era peor de lo que parecía: el endpoint
  de borrado aceptaba cualquier foto de un admin, pero el listado filtraba por
  `uploaded_by` sin mirar el rol **y** `/gallery` estaba guardado a `counselor`
  — o sea que el admin no tenía ninguna ruta a fotos. Ahora tiene pantalla
  propia con el día completo y el nombre de quien subió cada una.
- **Doble conexión del pool.** `module_on()` abría una segunda conexión
  mientras el handler ya tenía la suya. Solo afectaba a rutas core que
  preguntan por un módulo a mitad de camino (hoy, únicamente el roster): en las
  rutas gateadas el `before_request` ya llenó el cache. Ahora se le puede pasar
  la conexión existente.

---

## Pendiente

**Del scope JCCNS**
- `late_arrivals` — el quinto módulo, pospuesto explícitamente.
- Ausencias recurrentes: existen en backend, **no están conectadas en la SPA**.

### El admin legacy: de 27 endpoints a 6

`public/admin/index.html` sigue existiendo, pero la SPA ya no manda a nadie
ahí. Se reconstruyeron: upload de roster, exports (roster / asistencia /
ausencias), setup de 2FA, vistas de asistencia por semana y mes, make-up
classes del lado admin, rosters y horarios de actividades, import de
calendario, composición de mensajes, gráficos del dashboard, y una pantalla
de mantenimiento con end-of-year y wipe-all-data.

**La forma de verificar que no se abrió una salida nueva** es comparar qué
endpoints usa cada app — no `parity-audit.md`, que está desactualizado y lista
como MISSING cosas construidas hace rato:

```python
import re, pathlib
def eps(t):
    return {re.sub(r'/\d+','',m.group(1).rstrip('/'))
            for m in re.finditer(r"['\"`](/api/[A-Za-z0-9/_\-]*)", t)}
legacy = eps(pathlib.Path('public/admin/index.html').read_text())
spa = set()
for f in pathlib.Path('web/src').rglob('*.ts*'):
    spa |= eps(f.read_text())
print(sorted(e for e in legacy if e not in spa))
```

Lo que queda solo en el legacy, a propósito:

- **`demo-token` / `demo-status`** — el lanzador de demo. Para funcionar tiene
  que **reemplazar la sesión del propio admin** en localStorage, que es
  compartida entre pestañas: el admin quedaría deslogueado de su cuenta sin una
  vuelta atrás. Es una decisión de diseño, no trabajo pendiente. El bug de
  backend sí se arregló (ver abajo).
- **`activity-roster/manual` + `child-search` + `children`** — entradas
  manuales al roster de actividades, con autocompletado de chicos.

### Bug arreglado de paso: demo mode sin organización

`/api/admin/demo-token` armaba los claims sin `'org'`, así que la sesión de
demo quedaba sin organización, RLS le vaciaba cada pantalla y el demo mostraba
una app que funciona y no tiene nada adentro. Demo mode es de junio, anterior al
rewrite multi-tenant, y no se actualizó. Ahora incluye el claim, igual que el
login real.

### `ModuleGuard`

El riesgo 3 —pantalla que llama a un endpoint gateado— ahora es estructural en
vez de recordable. `web/src/components/ModuleGuard.tsx` envuelve las ocho rutas
admin que pertenecen a un módulo. Sin él, esconder el item del nav no protegía
nada: la ruta seguía siendo alcanzable por URL o bookmark, cada request volvía
403, y React Query dejaba `data` en undefined, así que la pantalla mostraba su
empty state. *"No make-up classes booked"* es mentira cuando la verdad es que el
JCC nunca compró el módulo.

**Decisión abierta: rooms.** El feature dice "live roster per room" y la entidad
no existe. El headcount agrupa **por escuela**. Si el JCCNS necesita salones de
verdad, toca roster, attendance y actividades — resolverlo **antes** de tocar
más el schema de asistencia.

**Operativo**
- ~~Crear la organización del JCCNS en `/app/organizations` y prender su combo~~
  ✅ **hecha el 2026-08-03**, verificada el 08-04: `jccns` (id 2) con `pickups`
  off, `secure_pickup` / `check_in_out` / `photos` / `parent_messaging` on, más
  `daily_ops` on.
- ~~Bucket privado en Supabase Storage~~ ✅ **hecho** — ver abajo.
- Pasar el servicio de `free` a `starter`.
- Cargar SMTP y VAPID (riesgo 8).

### Bucket de fotos ✅ hecho el 2026-08-02

Creado en el proyecto `trxnvcrjyqkbmbobjkys` con la config que espera
`photo_storage.py`:

| | |
|---|---|
| nombre | `photos` |
| público | **false** — las lecturas van por signed URL, como pide el módulo |
| límite | 8 MB, igual a `MAX_PHOTO_BYTES` en `app.py:3796` |
| MIME | `image/jpeg`, `image/png`, `image/webp`, `image/heic` |

El límite y los MIME types están puestos **en el bucket**, no solo en la app: si
algún día se saltea la validación de `app.py`, Supabase igual rechaza. Probado
de punta a punta con la `service_role` — upload 200, signed URL OK, `text/plain`
rechazado con 400, delete 200, bucket vacío.

`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y `SUPABASE_PHOTOS_BUCKET` quedaron
cargadas en el servicio `-tunz`.

**Ojo:** cambiar variables de entorno por la API de Render **no dispara
redeploy**. ~~Hay que reiniciar el servicio a mano (`render restart <id>`)~~ —
❌ **corregido el 2026-08-04: `render restart` tampoco alcanza.** Reinicia el
contenedor con el entorno que ya tenía; lo que materializa una variable nueva es
`render deploys create <id> --confirm --wait`. Comprobado a la mala (ver la
sesión de infra del 08-04). Falta todavía la única prueba que no se puede hacer
sin loguearse: subir una foto real desde la pantalla de counselor y confirmar
que la otra familia ve la galería vacía.

---

## Próximos pasos, en orden

Los tres primeros de la versión anterior ya están hechos: el schema aplicó en
Supabase, RLS quedó verificado y el bucket existe. Lo que queda:

1. ~~**Probar el 403 con curl.**~~ ✅ **hecho el 2026-08-04** — ver riesgo 2.
2. **Probar fotos con dos familias.** Subir una foto taggeada a un solo chico
   desde la pantalla de counselor y confirmar que la otra familia ve vacío. El
   bucket ya está probado; lo que falta es el camino por la app.
3. **Cargar SMTP y VAPID**, o asumir que no hay ni mail ni push.
4. **Pasar a `starter`** antes de entregar — en `free` cada SSE muere a los ~15
   minutos de idle, y con él la cola de pickups y el headcount.
5. **Apagar `SEED_TEST_ACCOUNTS`** antes de que entren familias reales.
6. ~~**Crear la organización del JCCNS** con su combo de módulos.~~ ✅ **hecha el
   2026-08-03** (`jccns`, id 2), verificada el 08-04 con el combo completo.
7. **Decidir rooms** con el JCCNS. *(Al 08-04 la tabla `rooms` existe y tiene
   **0 filas** en producción.)*
8. Recién entonces `late_arrivals`, o sacarlo del catálogo mientras tanto.

Para correr los tests localmente, usar el intérprete del venv — el `python3` del
sistema es 3.9 y explota con la sintaxis de tipos de `tenancy.py`:

```
.venv/bin/python tests/test_module_access.py
```

---

## Las tres reglas de este código

1. **Tabla nueva** → `init_db()` en `server/database.py` **y** `TENANT_TABLES`
   en `server/tenancy.py`. Sin lo segundo no tiene `organization_id` ni policy,
   y se filtra entre JCCs.
2. **Endpoint nuevo de un módulo** → `MODULE_ROUTES`. Sin eso el toggle se ve
   pero no protege nada.
3. **Pantalla que llama a un endpoint gateado** → `hasModule` antes del fetch.
   Ver riesgo 3.

Y al agregar un módulo son **tres** lugares: `MODULES` en `server/tenancy.py`,
el type `ModuleKey` en `web/src/lib/auth.ts`, y las rutas en `MODULE_ROUTES`.
