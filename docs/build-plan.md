# Plan de build — JCCSN "J Adventure"

Sale de [`jccsn-daily-ops-spec.md`](./jccsn-daily-ops-spec.md) (el walkthrough con
Heather) cruzado contra los dos archivos reales
([`source-files-analysis.md`](./source-files-analysis.md)) y contra lo que ya está
deployado.

Escrito el 2026-08-03. **No se escribió código todavía.**

---

## 0. El punto de partida no es cero

El pedido pedía "stack recomendado". No hay nada que recomendar: **la app existe,
está deployada y sirve tráfico** en `afterschool.kikarlabs.com`. Lo que sigue es
el inventario de lo que hay, para que el plan se lea contra eso.

| | |
|---|---|
| Backend | Flask 3.1 / Python 3.11, un solo `server/app.py`, **137 rutas `/api/*`** |
| DB | PostgreSQL en Supabase, **33 tablas**, RLS activa en 34 de 36 y verificada en vivo |
| Frontend | React 19 + Vite 8 + TS + Tailwind 4, **21 pantallas**, dos shells (móvil y desktop) |
| Multi-tenant | Aislamiento por organización en RLS, con **15 módulos** vendibles por separado |
| Realtime | SSE sobre `LISTEN/NOTIFY`, un canal por organización |

> **Nota:** el `CLAUDE.md` del repo dice "~93 rutas" y "~19 tablas". Está
> desactualizado: hoy son 137 y 33. Conviene corregirlo.

De la lista de features del JCC, **cuatro de cinco módulos ya están construidos**
(`secure_pickup`, `check_in_out`, `photos`, `parent_messaging`) y el quinto
(`late_arrivals`) es un toggle sin código detrás.

**La conclusión que cambia el plan:** lo que falta no es una app. Es el
**motor de vistas derivadas** —las 33 hojas que Heather arma a mano cada día— y
un importador que entienda *su* archivo. Eso es lo que ordena las fases de abajo.

### R6 ya se cumple, y es la restricción que manda

> **R6 — el sign-out ocurre solo en dispositivos del staff con captura de firma.
> Los padres nunca pueden firmar la salida desde su teléfono.**

Verificado en el código, no asumido: `POST /api/counselor/pickup/release`
(`server/app.py:4935`) rechaza con 403 cualquier rol que no sea counselor o
admin; la firma es obligatoria en servidor (`app.py:4687`) y en cliente
(`ReleaseChild.tsx:151`); se guarda en `pickup_releases.signature` (BYTEA); y del
lado del padre solo existe la administración de la lista de autorizados.

**Toda decisión de arquitectura de acá en adelante se mide contra esto.** En
concreto, la hoja `{Día} - Sign Out` del §3.7 se implementa **solo** como
pantalla de counselor. Ningún endpoint de sign-out puede quedar accesible al rol
parent, y ninguna pantalla de parent puede disparar un release.

---

## 1. Schema — la §4 del spec contra lo que ya existe

Trece entidades pide el spec. Cuatro están, cinco necesitan cambios, cuatro no
existen.

| §4 del spec | Hoy | Qué hay que hacer |
|---|---|---|
| `SignOut(child, date, signature, ts, staff)` | **`pickup_releases`** + `signature BYTEA` | ✅ nada — R6 completa |
| `AbsenceChange(child, date, type, note, source)` | `absences`, `recurring_absences`, `absence_exceptions` | Falta el tipo `change` (§3.3: *"Add Asher Y to bus and swim"*) y `source: parent\|admin` |
| `BusRoute(school → counselors)` | `counselor_schools` | Sirve. Falta que soporte **varios counselors por escuela** (`"Gianna & Khloe"`) |
| `Contact(child, name, phone, email, priority)` | `users` rol parent + `children.parent_id` | Un solo parent por chico. Hace falta tabla propia con `priority 1\|2` |
| `Child(...)` | `children` — solo `name, parent_id, school_id, service_type, release_group, active` | **Faltan `dob`, `sex`, `allergies`, `bus_rider`, `notes`, `status active/withdrawn`** |
| `Enrollment(child, weekday, dismissal_time)` | `registrations(child_id, day_of_week)` | **Falta `dismissal_time`** — el dato central de R1 y R2 |
| `ClassSession(name, weekday, start, end, location)` | `activities` + `activity_schedules` | `activities` no tiene horas ni lugar; `activity_schedules` tiene `dropoff/pickup_time` pero se ata por **patrón de nombre**, no por id. **Falta `end_time` y `location`** — sin `end` no se puede computar R2 |
| `ClassEnrollment(child, class_session)` | `activity_roster` | Guarda **`child_name TEXT`, no un FK a `children`**. Para R4 hay que migrarlo a `child_id` |
| `AttendanceEvent(child, date, type, status, ts)` | `attendance_records` | Una fila por chico y día. El spec pide **eventos** (`bus_pickup`, `care_check`, `class_checkin`) — varios por día |
| `Room(name, capacity_hint)` | — | **Nuevo** (R7) |
| `CareAssignmentRule(weekday, block, grade_range → room)` | — | **Nuevo** (R7) |
| `StaffAssignment(...)` + override por fecha | `counselor_time_off`, `activity_roster_overrides` | **Nuevo** (R8): plantilla semanal por bloque con `LEAD/ASSIST`, más horas por día |
| `ComplianceChecklist(child, items…)` | — | **Nuevo**. 10 columnas `U–AD`. Solo admin |

### Las dos decisiones de schema que bloquean

1. **`Room` — es la "decisión de rooms" que el handoff viene arrastrando.** R7 la
   cierra: *el admin crea salas con nombre y les asigna rangos de grado*, no un
   algoritmo fijo. Las salas ya aparecen en los datos: Ocean, Gym, Playground,
   WKL, MPR, Courts, Pool. **Esto desbloquea el schema de asistencia**, que el
   handoff pedía no tocar hasta resolverlo.
2. **`dismissal_time` en `Enrollment`.** Sin él no hay R1, R2, sign-out agrupado
   ni bus manifest. Es la columna más barata y la que más cosas prende.

---

## 2. Fases

Ordenadas por dependencia real: nada de una fase se puede construir sin lo
anterior.

### Fase 0 — Cerrar las preguntas que bloquean (sin código)

Bloquean el importador, así que van antes que él. Salieron del cruce con los
archivos reales. **Quedan dos abiertas de tres.**

1. ~~**¿`SG: REMOVE` es baja del programa?**~~ El spec dice ignorar la columna A;
   ahí hay 30 chicos marcados. **Resuelto: se ignora.** No infla el padrón —
   los 30 están entre los 60 sin ningún día inscripto, así que no aparecen en
   ninguna vista derivada igual.
2. ~~**¿Qué pasa cuando el retiro es anterior al fin de la clase?**~~
   **Resuelto (2026-08-04): el caso no existe.** Heather confirmó que una clase
   nunca termina después de la hora de retiro, así que R2 tiene exactamente dos
   ramas y el motor tres. Las **4 filas del libro de junio que sí lo violan**
   pasan de ser una regla sin descubrir a ser un error de carga: se tratan como
   advertencia de la §6.3, con `PARENTS` de fallback. Ver la fase 2b.
3. **¿De dónde salen los chicos de las 3:00?** R1 los define, las hojas de día
   los tienen, el roster no trae un solo `3`. **Sigue abierta.**

Quedan además las **cinco preguntas de la §7 del spec**, que corren en paralelo
porque no bloquean el importador. Una sí bloquea más adelante: **los cupos
(pregunta 5)** son el campo `capacity` del catálogo de clases de la §6.1, y sin
respuesta la advertencia *"clase pasada de cupo"* de la §6.3 no tiene contra qué
comparar. El campo se construye opcional para no esperarla.

**Qué valida Heather:** una llamada de 20 minutos. Sin esto el importador se
escribe dos veces.

---

### Fase 1 — Importador del archivo de Heather

Es primero porque **todo lo demás deriva del roster**, y porque hoy no hay nada
reusable: el importador que existe (`/api/admin/upload-roster`, `app.py:2522`)
lee Excel **por posición** —`row[0]` nombre, `row[5]` contacto, `row[7]` mail,
`row[11]` opción de curso— contra un layout que no se parece en nada al del JCC.
Aplicado a este archivo tomaría la columna de notas de facturación como nombre
del chico. **No se toca** (otros JCCs lo usan): se escribe uno nuevo al lado.

Qué tiene que hacer, con lo aprendido de los archivos:

- **Resolver columnas por encabezado, nunca por índice.** El mapa del spec está
  corrido una columna desde la `U`, y la hoja `No Longer` tiene otro orden. Por
  nombre, los dos problemas desaparecen.
- **Una fila es un chico si y solo si `School` tiene valor.** Corta el bloque de
  borrador de 62 filas del pie, donde viven los 18 nombres repetidos.
- Partir `"Apellido, Nombre"`, deduplicar por **nombre + escuela + grado**
  (verificado: no colisiona en ninguna hoja) y agregar las inscripciones a clase
  de las filas repetidas (R4).
- Tolerar lo que el archivo tiene de verdad: `DOB` como fecha o texto, `x`/`X`/`NO`
  en `Bus`, fechas mezcladas con `x` en las 10 de cumplimiento, `Grade` como
  `int` o `str`, sufijos `**`.
- **Tabla de alias de escuela**, en los dos vocabularios: `Village`↔`M - V`,
  `Brown - Drop Off`↔`D.O.`, etc.
- **Reporte de revisión** en vez de fallar: escuela desconocida (`????`,
  `NUMBERS`, `REG`), sin hora de retiro, grado raro. El spec lo pide en §5.
- `No Longer` → `status = withdrawn`, no borrado.

**Qué valida Heather:** sube su archivo sin tocarlo y ve una pantalla que dice
*"157 chicos, 60 sin días inscriptos, 1 escuela para resolver"*, con la
lista de las 4. Puede abrir tres chicos y confirmar contra su Excel que el
horario de retiro, la escuela, las alergias y los dos contactos son correctos.
Es la primera vez que su archivo entra a un sistema sin que ella lo retipee.

---

### Fase 2 — Vistas derivadas del día

El corazón: las 33 hojas dejan de existir. Depende entera de la fase 1.

> **La §6 del spec reordenó esta fase.** Antes era una lista de las siete hojas
> del §3. Pero la §6.1 dice que Heather primero **configura ocho cosas**, y que
> recién con esas ocho el motor deriva solo. Las hojas no son la entrada: son la
> salida. Por eso la fase va partida en **2a — la configuración**, **2b — las
> vistas** y **2c — lo que la §6.3 agrega y el Excel no tenía**.

#### Fase 2a — Las ocho cosas que el admin configura (§6.1)

En el orden de dependencia que da el spec, porque ninguna se puede cargar sin la
anterior:

| # | Qué | Estado hoy |
|---|---|---|
| 1 | **Catálogo de clases** — nombre, día, inicio/**fin**, lugar, cupo opcional | ✅ **`class_sessions`**, `sql/35` + rollback `sql/36`, espejada en `init_db()` y en `TENANT_TABLES`. **Faltan endpoints y UI**: la pantalla donde Heather carga las horas todavía no existe, y sin horas no hay R2 |
| 2 | **Inscripciones a clase** — varias por chico y por día, con encadenado auto-detectado (fin de A == inicio de B → `Dismiss To` de A es B) | ✅ **`class_enrollments`**, misma migración. El importador ya **las escribe** en vez de tirarlas. El encadenado sigue sin implementar — es derivado de las horas, así que espera al paso 1 |
| 3 | **Salas** (R7) | **Ya está en la base.** `rooms` existe desde `sql/29`, espejada en `init_db()` y en `TENANT_TABLES`. Cero endpoints, cero UI |
| 4 | **Reglas de care** — día + bloque + rango de grados → sala | **Ya está en la base.** Idem `care_assignment_rules`, con el orden de desempate ya decidido en el banner de `sql/29` |
| 5 | **Lista de staff** con horas por día | `users` rol counselor. Faltan las horas por día |
| 6 | **Plantilla semanal de staff** — bus / 3–4 / 4–5 / 5–6, con `LEAD`/`ASSIST` (R8) | **Tabla nueva** |
| 7 | **Overrides por fecha** — el que se reporta enfermo (R8) | **Tabla nueva** (o columna de fecha en la 6) |
| 8 | **Rutas de bus** — escuela → counselor(s), plantilla + override | `counselor_schools`, que ya tiene ventana de vigencia (`effective_from`/`effective_to`, `sql/33`). Falta soportar **varios counselors por escuela** |

> ✅ **Hecho el 2026-08-04.** Los dos primeros pasos están en la base y el
> importador ya persiste los nombres de clase. Lo que sigue de 2a son los
> **endpoints y las pantallas** — `class_sessions` no tiene ninguno todavía, así
> que las horas no se pueden cargar y el motor de `Dismiss To` sigue sin poder
> computarse. Ver la sesión del 08-04 (clases) en el handoff.

**Lo primero de 2a, y es un arreglo, no una feature:** el importador ya lee los
nombres de clase de las columnas M/T/W/R/F —están en
`ParsedRegistration.classes` (`server/roster_import.py`)— y el commit **los
descarta**. `_apply_registrations` (`server/roster_staging.py:459`) los usa solo
para decidir si escribe la fila de `registrations` y después no los guarda en
ningún lado. Con el paso 2 de arriba dejan de perderse.

#### Fase 2b — Las siete vistas (§3)

Ahora sí. Primero **el motor de `Dismiss To`** (§4), que es de donde salen casi
todas:

```
siguiente clase encadenada, si existe        (R3)
→ si no, PARENTS   si fin de clase == hora de retiro   (R2)
→ si no, la sala de care de (grado, bloque)  (R7)
```

Verificado contra 59 filas reales sin una violación. **Y son tres ramas, no
cuatro:** Heather confirmó (2026-08-04) que una clase nunca termina después de la
hora de retiro, así que el cuarto caso no es ruteo.

Pero **el libro de junio lo produce cuatro veces igual** — filas donde la clase
termina después del retiro, tres despachadas a `PARENTS` en su propia hoja y una
a `Gym - CARE`. Una planilla hecha a mano se equivoca; la app se lo va a
encontrar. Cuando pase:

- **`PARENTS` de fallback.** Es lo que ella hizo en 3 de los 4, y es el único
  destino que no deja a un chico esperando en una sala a la que nadie lo fue a
  buscar.
- **Y una advertencia** en el tablero (§6.3, *chico sin destino computable*).
  Nunca care en silencio, que es exactamente lo que devolvería la lógica
  derivada de la §4 si esto no estuviera decidido.

Encima de eso, las siete vistas del §3, en este orden:

| # | Vista | Notas |
|---|---|---|
| 1 | Roster del día | Filtro del maestro por día. `**` **calculado**, no importado |
| 2 | Sign-Out (§3.7) | Agrupado por hora de retiro. **Pantalla de counselor únicamente — R6.** Reusa `pickup_releases`, que ya existe con firma |
| 3 | Bus manifest (§3.4) | Por escuela, con su counselor. `X`/`A` tap-to-check, y `Where to?` sale del motor |
| 4 | Class rosters (§3.5) | Un bloque por sesión, con `Dismiss To` computado |
| 5 | Care rooms (§3.6) | Las tablas ya existen (fase 2a, 3 y 4). La **negrita** de Heather sale calculada de los solapamientos |
| 6 | Absent/Changes (§3.3) | Feed por fecha; ausencias de padres + cambios del admin. Se refleja como `A` en las otras vistas |
| 7 | Staff schedule (§3.1) | Plantilla semanal + override por fecha (R8) |

**Qué valida Heather:** la prueba es dura y es la que importa. Elige un día de
junio, lo carga, y compara pantalla contra la hoja que ella imprimió esa semana.
Tienen que dar **el mismo chico en la misma sala a la misma hora**. Si el
`Dismiss To` coincide fila por fila, el motor es correcto.

> Ojo: el roster es de otoño 2026-27 y el libro de asistencia de junio 2026 — son
> cohortes distintas. Para esta prueba hay que cargar la hoja del día de junio,
> no el roster de otoño.

#### Fase 2c — Lo que la §6.3 agrega y el Excel no tenía

Las siete pestañas de 2b son paridad con el libro. Estas cuatro no tienen hoja de
la cual salir, y son la razón por la que el tablero es mejor que imprimir:

1. **Headcount en vivo por regla de care.** Cada fila sala×bloque dice cuántos
   chicos caen ahí hoy. Es el dato con el que Heather decide mover un rango de
   grados — el spec lo nombra como su criterio, no como un número de adorno.
2. **Advertencias.** Cuatro, y las cuatro son cosas que hoy se descubren a las
   3:05pm: slot de staff sin cubrir después de un llamado, chico sin destino
   computable (sin hora de retiro, clase sin sala, **o una clase que termina
   después del retiro** — el caso que la fase 0 declaró imposible y el archivo
   de junio produce cuatro veces), sala sin nadie en un bloque, clase pasada de
   cupo (bloqueada por §7 pregunta 5).
3. **Overrides de un toque, en cascada.** Marcar un counselor ausente y
   reasignar **solo por hoy**; marcar un chico ausente —o recibirlo del portal
   del padre— y que **se caiga de bus, clase, care y sign-out a la vez**,
   marcado `A` para la auditoría. La cascada es el requisito, no el toggle.
4. **Board de estado en vivo.** Dónde está cada chico ahora, computado del ruteo
   del día más los eventos de asistencia. Es lo que alimenta el *"¿dónde está mi
   hijo?"* de R10, que el spec deja como nice-to-have del lado del padre pero
   que del lado del admin sale del mismo cálculo.

---

### Fase 3 — La vista del counselor (R9, §6.2)

Reemplaza lo que Heather hace hoy a mano: imprimir cuatro páginas por counselor y
resaltar con marcador lo de cada uno.

Depende de la fase 2: es la misma data, filtrada por persona. Una pantalla "mi
día" en el shell móvil que ya existe: mi ruta de bus y mis chicos, adónde va cada
uno al bajar, mis clases con `LEAD`/`ASSIST`, y mi sala de care por bloque
(3–4, 4–5, 5–6).

Acá cierra el círculo de R6: el counselor tiene el sign-out **en el bolsillo**,
en el mismo dispositivo donde ve su día.

**Lo que la §6.2 agrega sobre R9:** el sign-out no vive en una pantalla aparte.
Se dispara **desde los dos lugares donde ocurre de verdad** — en el bloque de
clase, para los chicos cuyo `Dismiss To` es `PARENTS` (el instructor entrega y
firma ahí mismo, R2), y en el bloque de care, para todos los demás. El §3.7
describía una hoja; la §6.2 describe dónde se toca. Y cada chico del bloque de
clase lleva un chip de destino: `CARE {sala}`, `PARENTS {hora}` o el nombre de la
clase siguiente.

**Qué valida Heather:** entra como uno de sus counselors y ve exactamente lo que
le habría resaltado con marcador. Y deja de imprimir.

---

### Fase 4 — Portal del padre (R10)

Último porque el spec lo quiere **mínimo**, y porque casi todo ya está
construido: mensajería 1:1, fotos y calendario son módulos que existen.

Queda por hacer:

- **Reporte de ausencia** que caiga en el feed de Absent/Changes de la fase 2 y
  se refleje como `A` en bus, care y clases. Hoy `parent_mark_absence`
  (`app.py:991`) escribe en la DB y no avisa a nadie.
- **Conectar en la SPA** las ausencias recurrentes, que existen en backend y no
  están en el frontend.
- *"Dónde está mi hijo ahora"* — el spec lo marca **nice-to-have** (*"if it's not
  hard to do"*). Sale casi gratis del motor de la fase 2: es su bloque actual.
  Va último y se puede cortar.

**Qué NO se construye:** sign-out del lado del padre. R6. Y no hay tracking en
vivo como feature central — el spec es explícito.

**Qué valida Heather:** reporta una ausencia desde el teléfono de un padre de
prueba y la ve aparecer en el feed del día y como `A` en el manifiesto del bus,
sin tocar nada más.

---

## 3. Riesgos

1. **`SG: REMOVE` (fase 0, pregunta 1).** Si se resuelve mal, el programa arranca
   con 30 chicos de más o de menos. Es el único ítem que puede invalidar una
   importación entera.
2. **`activity_roster.child_name` es texto libre.** R4 pide *un chico → muchas
   inscripciones*, y eso necesita un FK. Migrar una tabla con datos de otros JCCs
   adentro pide plan de rollback, como manda el `CLAUDE.md`.
3. **`attendance_records` es una fila por día.** El spec pide eventos. Es la
   migración más invasiva y toca el flujo de check-in/out ya construido; hay que
   hacerla **después** de decidir rooms, no antes.
4. **Los archivos son de años distintos.** Sirven para validar reglas, no datos.
   Para probar de punta a punta hace falta el roster de otoño **con las columnas
   de clase ya cargadas**, que hoy están vacías porque los signups no ocurrieron.
   **Hay que pedírselo a Heather cuando lo tenga.**
5. **Nada de esto sirve si el módulo está apagado.** `secure_pickup` viene en
   `False` por default. La org del JCC necesita `secure_pickup` **on** y
   `pickups` **off**.

---

## 4. Lo primero que hay que hacer

En orden, y ninguna es de código:

1. La **pregunta que queda abierta en la fase 0** con Heather —de dónde salen los
   chicos de las 3:00— más las cinco de la §7 del spec. Las otras dos de la fase
   0 están resueltas.
2. **Confirmar los módulos de la organización del JCCSN.** Se reporta creada
   (2026-08-04); lo que falta verificar es que tenga **`daily_ops` prendido**,
   sin lo cual el importador ya construido responde 403 y su pantalla no aparece
   en el menú. Más el combo del handoff: `secure_pickup` on, `pickups` off.
3. **Pedir el roster de otoño con las clases cargadas** apenas existan los
   signups: sin eso las fases 2 y 3 no se pueden probar de verdad.
