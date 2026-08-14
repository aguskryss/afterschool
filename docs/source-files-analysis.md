# Los dos archivos del JCC — qué hay adentro de verdad

Inspección con `openpyxl` de los dos archivos que hoy manejan el programa a mano.
Escrito el 2026-08-03.

Los archivos **no están en el repo y no pueden estar**: tienen nombre, fecha de
nacimiento, alergias, medicación y teléfono de menores reales.
`docs/source-files/` está en `.gitignore`. Este documento es el único artefacto
que se commitea, y por eso acá no hay una sola fila de datos: solo estructura,
conteos y los valores de las columnas categóricas que no identifican a nadie.

> Contrastado contra [`jccsn-daily-ops-spec.md`](./jccsn-daily-ops-spec.md)
> secciones 1 y 2. El resultado está en *Verificación contra el spec*, al final:
> el mapa de columnas falla por una columna a partir de la U, y la regla R2
> —la más importante de la app— se confirmó sin una sola violación en los datos.

---

## Archivo 1 — `J_Adv_Fall_Roster_2026-27.xlsx`

Dos hojas: `J Adv Roster` (221 filas no vacías × 36 columnas) y `No Longer`
(vacía, solo encabezados).

### La hoja tiene dos bloques pegados, y solo uno son chicos

Es el hallazgo que más condiciona al importador. Las 221 filas se parten limpio
por si la columna `School` está llena:

| | filas | nombres | formato de nombre | Grade | DOB / contactos | flags |
|---|---|---|---|---|---|---|
| **Bloque A** — `School` con valor | 159 | todos distintos, **0 duplicados** | 157 en `Apellido, Nombre`, 2 no | `K,0,1,2,3,4,5` | sí (157) | los 87 |
| **Bloque B** — `School` vacía | 62 | 18 repetidos | 62 de 62 sin coma, 1 a 5 palabras | `Enrolled`, `waiting on HG`, vacío | ninguno | ninguno |

**El bloque B no son chicos.** Es área de borrador al pie de la hoja: sin fecha
de nacimiento, sin contacto, sin grado válido, y con los nombres escritos al
revés que arriba. Los 18 "nombres duplicados" del total salen todos de ahí; el
bloque A no tiene ni uno.

### Pero el bloque A tampoco son 159 chicos: son 157

Las dos filas del bloque A que no están en `Apellido, Nombre` **no son chicos**:
son renglones de leyenda que quedaron con algo escrito en `School`.

| `School` | "nombre" | coma | DOB | contacto |
|---|---|---|---|---|
| `REG` | `BUS ONLY - EHS` | no | no | no |
| `NUMBERS` | `Bball 3:15p-4p` | no | no | no |

`????` en cambio **sí es un chico**: tiene coma, DOB y contacto. Es una escuela
desconocida, no una fila basura — y por eso el importador tiene que poder
resolver escuelas a mano en vez de descartar la fila.

→ **Regla del importador, en dos cláusulas:** una fila es un chico si `School`
tiene valor **y** no es un renglón de leyenda (sin coma en el nombre **y** sin
contacto **y** sin DOB). Cortar por número de fila es frágil — los bloques no son
del todo contiguos (hay dos filas con escuela metidas dentro del rango del
bloque B).

**Padrón real: 157.**

### El flag de la columna 0, y por qué se puede ignorar

La columna se llama `?? for parents` y son anotaciones del staff con sus
iniciales adelante. Solo aparece en el bloque A, en 87 de los 157 chicos (las
dos filas de leyenda no tienen flag):

| valor | filas |
|---|---|
| `SG: New 2026-27` | 45 |
| `SG: REMOVE` | **30** |
| `HG: Waiting on Paperwork` | 11 |
| `SG: Returning 2026-27` | 1 |

El spec manda ignorar esta columna —es del área de facturación— pero 30 chicos
dicen `REMOVE`, así que parecía que ignorarla inflaba el padrón un 23%.

**No lo infla, y esto se puede verificar:** los **60 chicos sin ningún día
inscripto** son exactamente los 30 `SG: REMOVE` + los 11
`HG: Waiting on Paperwork` + 19 en blanco. O sea que **los `REMOVE` ya quedan
fuera de todas las vistas diarias por las columnas de día**, sin que la columna A
tenga que desactivarlos.

→ **Decisión tomada: la columna A se guarda (`children.roster_flag`) y no hace
nada.** Se importan los 157. Los 60 sin días no aparecen en ninguna vista
derivada, que es el comportamiento correcto — pero el resumen del importador
tiene que decir el número, o en la fase 2 va a parecer un bug.

### Columnas, y qué guardan de verdad

| # | Columna | Fill | Qué es |
|---|---|---|---|
| 0 | `?? for parents` | 39% | Flag de staff. Ver arriba. |
| 1 | `School` | 71% | 10 valores, con basura: `Brown`, `Glover`, `Village`, `SPS`, `EHS`, `Brown - Drop Off`, `SPS - Drop Off`, `????`, `NUMBERS`, `REG` |
| 2 | `Child's Name` | 100% | `Apellido, Nombre` en el bloque A. **Un solo campo**, hay que partirlo |
| 3 | `Grade` | 99% | Mezcla `int` y `str`: `K`, `0`–`5` |
| 4,6,8,10,12 | `Mon` `Tue` `Wed` `Thur` `Fri` | 24–38% | **No son booleanos: son la hora de retiro** (`4`, `5`, `6`) y un `Online ` suelto |
| 5,7,9,11,13 | `M/T/W/R/F - Class` | 0–2% | Vacías salvo 6 celdas con texto de espera. **Muertas en este archivo** |
| 14 | `Bus` | 69% | `X`, `x`, `NO`, `??` — hay que normalizar mayúsculas |
| 15 | `Sex` | 70% | `F`, `M` |
| 16 | `Notes` | 71% | Texto libre |
| 17 | `DOB` | 71% | 156 `datetime` + **1 string** — el importador tiene que tolerar los dos |
| 18 | `B-Day Card` | 28% | `x`, `na` |
| 19 | `Allergies` | 71% | Texto libre. **Dato médico** |
| 20,21 | `Regist Rcvd`, `Regist Fee Chged` | 45% | Fechas (una tiene un string suelto) |
| 22 | `Member? Y/N/Sent` | 45% | Siempre `Y` |
| 23 | `Pick up (pg 2)` | 45% | `x`, `MISSING` |
| 24,25 | `First Aid (pg 2)`, `Medication (pg 4)` | 45% | Formularios firmados. **Dato médico** |
| 26 | `Photo` | 45% | `x`, `requested` — consentimiento de foto |
| 27,28,29 | `Physical`, `Imm.`, `complete` | 30–45% | Fechas mezcladas con `x` |
| 30–35 | `Contact #1/#2`, `Phone`, `Email` | 68–71% | **Dos contactos por chico, en columnas repetidas** → tabla aparte |

### La hoja `No Longer` cambia el orden de las columnas

Está vacía, pero sus encabezados **no coinciden** con los de la hoja principal:
empieza en `Notes` en vez de `?? for parents`, dice `Pick up (pg 3)` en vez de
`(pg 2)`, y no tiene `B-Day Card` ni `Photo` (34 columnas contra 36).

→ **El importador tiene que mapear por nombre de encabezado, nunca por índice.**

---

## Archivo 2 — `6_15_26-6_19_26_-_Attendance.xlsx`

**33 hojas**, agrupadas por día de la semana. Es el paquete que se imprime cada
semana: cada hoja es una planilla de papel, no una tabla.

| Día | Staff | Roster del día | Ausencias | Bus | Clases | Care | Sign Out |
|---|---|---|---|---|---|---|---|
| Lunes | `M-Staff` | `Monday` | `M - Absent.Changes` | `M-Bus` | `M - Classes` | `M - Care` | `M - Sign Out` |
| Martes | `T-Staff` | `Tuesday` | `T - Absent.Changes` | `T-Bus` | `T-Classes` | `T Care` | `T- Sign Out` |
| Miércoles | `W-Staff` | `Wednesday` | `W - Absent.Changes` | `Wed - Bus` | `W- Classes` | `W - Care` | `W-Sign out` |
| Jueves | `R-Staff` | `Thursday` | `R - Absent.Changes` | `Thur-Bus` | `R-Classes` | `R-Care` | `R - Sign out` |
| Viernes | `F-Staff` | `Friday` | `F - Absent.Changes` | `F-Bus` | `F-Classes.Care` ← fusionada | **no existe** | |

Los nombres de hoja son inconsistentes a mano (`T Care` sin guion, `W-Sign out`
en minúscula, `Wed - Bus` y `Thur-Bus` con el día abreviado distinto). El viernes
fusiona clases y care en una hoja y **no tiene hoja de Sign Out**.

→ Resolver hojas por *patrón*, no por nombre literal, y no asumir que los cinco
días tienen la misma forma.

### Lo que sirve: la hoja del día

`Monday` … `Friday` son las únicas hojas rectangulares y limpias:
`School | Child's Name | Grade | <Día> | <D> - Class`, 100% de fill.
Lunes 75 chicos, martes 84.

- **`Child's Name` está 100% en `Apellido, Nombre`** — igual que el bloque A del
  roster. Los dos archivos se pueden cruzar por ese campo.
- **La columna del día es la hora de retiro**, confirmando la lectura del roster:
  lunes `5`(36) `4`(22) `5**`(12) `6`(4) `3`(1).

### Los códigos de escuela no son los mismos que en el roster

Asistencia usa `M - B`, `M - G`, `M - V`, `SPS`, `EHS`, `D.O.`; el roster usa
`Brown`, `Glover`, `Village`, `SPS`, `EHS`, `Brown - Drop Off`.

`M - B/G/V` aparece **también en la hoja del martes**, así que la `M` no es
"Monday": es Marblehead, y Brown / Glover / Village son sus escuelas. `D.O.` es
Drop Off. Hace falta una tabla de alias escuela→código; no se puede inferir del
string.

### Tres cosas que un importador que lee solo valores va a perder

1. **El `**` de la hora de retiro.** `5**` y `6**` conviven con `5` y `6` y su
   significado no está en ninguna celda del libro.
2. **La negrita significa algo.** `M - Care` trae la nota
   `BOLD = will only be there...` y tiene 6 nombres en negrita contra 25 en
   redonda. Es estado de asistencia guardado en el **formato**, no en el valor.
3. **Los encabezados se repiten adentro de los datos.** Las hojas de Bus, Classes
   y Care son de dos y tres bloques lado a lado para imprimir, con la fila de
   encabezado repetida en el medio: `Grade`, `Student` y `Where to?` aparecen
   como si fueran valores. `M-Bus` además mete filas de sección dentro de la
   columna de alumnos (`Brown Counselor: Alexus`, `Drop Off: Katelyn (5p)`).

### Las hojas de ausencias son un cuaderno, no una tabla

`M - Absent.Changes` y sus hermanas tienen **una fila de encabezado con 12 fechas
semanales** (6/4 → 22/6 — o sea que cubren toda la temporada, no la semana del
nombre del archivo) y debajo texto libre:

```
Charlotte C - absent          ← mismo texto en las columnas 6/8 y 6/15
Add Asher Y to bus and swim team
done for the year
```

Los chicos van como `Nombre + inicial` (`Charlotte C`, `Rex S`), que **no cruza**
con el `Apellido, Nombre` del resto. Y mezclan ausencias con cambios de
inscripción en el mismo campo. Esta hoja no es importable a datos estructurados;
es el argumento más fuerte a favor de la app.

### Las hojas de Sign Out son la R6 en papel

`M - Sign Out` es `Child's Name | Grade | Class | Leaving @ | Time Out |
Initials`. **`Time Out` + `Initials` es exactamente la captura de firma de la
R6**, hecha con lapicera: el staff anota la hora y pone sus iniciales. Hoy están
casi vacías (7% de fill) porque se llenan a mano durante el turno.

Es el flujo que la app ya reemplaza — ver *R6* abajo.

---

## R6 — ya se cumple en el código de hoy

> **R6: el sign-out ocurre solo en dispositivos del staff con captura de firma;
> los padres nunca pueden firmar la salida desde su teléfono.**

Verificado contra el código actual, no asumido:

- `POST /api/counselor/pickup/release` (`server/app.py:4935`) rechaza con 403
  cualquier rol que no sea `counselor` o `admin` (`app.py:4948`).
- La firma es obligatoria de los dos lados: `decode_signature()` levanta
  `'A signature is required'` (`app.py:4687`) y el botón del cliente está
  deshabilitado sin trazo (`web/src/components/ReleaseChild.tsx:151`).
- Al padre solo le llega `/api/parent/authorized-pickups`, que administra **la
  lista de personas autorizadas**. No existe ningún endpoint de release del lado
  parent.
- Release, cierre de asistencia y notificación comparten una transacción
  (`app.py:4938-4946`).

**Lo que hay que cuidar hacia adelante:** el módulo `secure_pickup` viene en
`False` por default (`server/tenancy.py:41`). La R6 se cumple cuando está
prendido; con el módulo apagado no hay flujo de sign-out **ninguno**, ni bueno ni
malo. La organización del JCC tiene que tener `secure_pickup` en **on** y
`pickups` en **off** — es el combo que ya pide `jccns-scope.md`.

---

## Verificación contra el spec

### §1 · Mapa de columnas — correcto hasta la T, corrido una columna desde la U

De la A a la T, las 20 columnas que el spec mapea explícitamente **coinciden
todas** con el archivo. De ahí en adelante no.

El spec agrupa la cola como `U–AC` = checklist de cumplimiento y `AD–AI` =
contactos. Pero el propio spec **lista diez nombres** para el rango `U–AC`, que
son nueve columnas. El archivo real:

| | spec | real |
|---|---|---|
| Checklist (10 columnas) | `U–AC` | **`U–AD`** |
| Contactos (6 columnas) | `AD–AI` | **`AE–AJ`** |

`complete` es AD, no AC. Todo lo que viene después está corrido una columna.

**Por qué importa:** un importador escrito literalmente sobre el spec leería la
columna `complete` como *Contact #1* y se comería `Email #2` entera. Es el tipo
de error que no explota: importa 157 chicos con un contacto basura cada uno.

→ **El importador tiene que resolver por nombre de encabezado.** Con eso el bug
no puede pasar, y además queda cubierta la hoja `No Longer`, que tiene otro
orden (ver abajo).

### §1 · Otros desvíos

- **Los códigos de escuela del spec son los del archivo B, no los del A.** El
  spec dice que la columna `School` del roster trae `M-V (Village)` y
  `D.O. (drop-off)`. El roster real dice `Village`, `Brown - Drop Off` y
  `SPS - Drop Off`; `M - V` y `D.O.` solo existen en el libro de asistencia. Son
  **dos vocabularios distintos** y hace falta una tabla de alias.
- **Tres valores basura** en `School` dentro del bloque A: `????`, `NUMBERS`,
  `REG`. El spec no los prevé y por la regla de importación cuentan como chicos.
- **Grados 5 y 0.** El spec dice `K, 1, 2, 3, 4`; el archivo tiene además `5`
  (real) y `0` (probablemente K cargado como número).
- **`No Longer` no tiene "las mismas columnas"** como dice el spec: son 34 y no
  36, arranca en `Notes`, y dice `Pick up (pg 3)` en vez de `(pg 2)`.
- **La columna A no es ignorable.** El spec es tajante —*"the first column you
  can completely ignore"*— pero ahí viven los 30 `SG: REMOVE`. Ver ambigüedad 1.

### §2 · R2 — verificada contra los datos, sin una sola violación

Es la regla que el spec llama la más importante de la app, así que se comprobó
fila por fila sobre `M - Classes`, cruzando la hora de fin de cada clase contra
la hora de retiro del chico:

| caso | filas | resultado |
|---|---|---|
| fin de clase **<** retiro → care o clase encadenada | 49 | ✅ |
| fin de clase **=** retiro → `PARENTS` | 10 | ✅ |
| **fin de clase > retiro** | 4 | ⚠️ la regla lo prohíbe — dato malo |
| | **59 conformes, 0 violaciones** | |

**El cuarto caso no es una regla sin descubrir: es un error de carga.** 4 chicos
tienen hora de retiro *anterior* al fin de su clase — tres salen a `PARENTS` y
uno a `Gym - CARE`. Parecía una rama faltante del spec hasta que Heather lo
respondió (2026-08-04): **una clase nunca termina después de la hora de retiro.**
O sea que R2 tiene exactamente dos ramas, el motor tres, y estas 4 filas son la
planilla hecha a mano equivocándose.

Lo que importa es que **el hallazgo se queda acá**: son la prueba de que la app
tiene que validar. La lógica derivada de la §4, sin decisión, devolvería care en
los cuatro — un chico esperando en una sala a la que el padre no lo fue a buscar.
La resolución está en la ambigüedad 2: `PARENTS` de fallback **más advertencia**.

### §2 · R3 — el `**` queda decodificado y cuadra numéricamente

El spec dice que `**` marca a los chicos con más de una clase ese día. Se puede
verificar, porque esos chicos además ocupan una fila por clase (R4). Si la
lectura es correcta, `filas con **` = `2 × filas duplicadas`:

| día | filas duplicadas | `**` esperados | `**` reales | |
|---|---|---|---|---|
| Lunes | 6 | 12 | 12 | ✅ |
| Martes | 5 | 10 | 10 | ✅ |
| Miércoles | 12 | 24 | 24 | ✅ |
| Jueves | 10 | 20 | 18 | ⚠️ faltan 2 |
| Viernes | 0 | 0 | 0 | ✅ |

Cuadra exacto en cuatro de cinco días. El jueves quedan dos filas sin marcar —
un olvido al cargarlo a mano, no otra regla. **`**` es derivable**: la app lo
calcula contando inscripciones, no lo importa.

### §2 · R4 — la duplicación está en el archivo B, no en el A

El spec la describe sobre el roster, pero **el bloque A no tiene ni una fila
duplicada** (157 chicos, 157 nombres distintos): las columnas de clase todavía
están vacías porque los signups de otoño no ocurrieron. La duplicación aparece
en las hojas de día del libro de asistencia (6, 5, 12, 10 y 0 filas de más).

Y la clave de deduplicación que propone el spec —nombre + escuela + grado— **es
segura**: en las cinco hojas, la cantidad de tripletas distintas es exactamente
igual a la de nombres distintos. No hay dos chicos que colisionen.

### §2 · R1 — cuatro horarios, pero el roster solo trae tres

Las cuatro horas de retiro (3, 4, 5, 6) están en el libro de asistencia. **En el
roster no hay un solo `3`**: sus columnas de día traen únicamente 4, 5 y 6. Los
chicos de las 3:00 —los que se caminan a Hillel, el `BUS ONLY - EHS` de R1— no
salen del roster tal como está. Ver ambigüedad 3.

### La negrita ya no es un misterio

La leyenda completa, cortada en la vista de la hoja, es:

> `BOLD = will only be there for part of the time due to the class they are in`

O sea: en una sala de care, negrita = el chico está solo parte del bloque porque
tiene una clase encima. **Es derivable** de los horarios de clase contra el
bloque de care. No hay que importarlo ni preservar el formato.

### Los dos archivos son de años distintos

El roster es de **otoño 2026-27** y el libro de asistencia es de la semana del
**15 al 19 de junio de 2026**, o sea el final del ciclo anterior. No son la misma
población y no se pueden cruzar chico por chico: el roster trae 157 y los días de
junio entre 35 y 91. Sirven para validar *reglas*, no para validar *datos*.

---

## Ambigüedades y conflictos — para preguntarle a Heather

### Resueltas

- ~~**`SG: REMOVE` (30 chicos) contra "ignorá la columna A".**~~ **La columna A se
  ignora**, como dice el spec. No infla el padrón: los 30 `REMOVE` están entre los
  60 chicos sin ningún día inscripto, así que no aparecen en ninguna vista
  derivada igual. El valor se guarda en `children.roster_flag`, inerte.
- ~~**Retiro anterior al fin de la clase** (4 casos).~~ **El caso no existe**
  (Heather, 2026-08-04): una clase nunca termina después de la hora de retiro, así
  que R2 tiene dos ramas y el motor tres. No hay cuarta rama que cerrar. Pero las
  4 filas del libro de junio siguen ahí, así que el comportamiento cuando la app
  se las encuentre queda definido igual: **`PARENTS`** —el padre busca al chico
  en la actividad, y es lo que Heather hizo en 3 de los 4— **más una advertencia**
  en el tablero (§6.3). Nunca care en silencio.
- ~~**Escuelas basura** (`????`, `NUMBERS`, `REG`).~~ `NUMBERS` y `REG` son las
  dos filas de leyenda y no se importan. `????` **sí es un chico** y su escuela se
  resuelve a mano en el preview del importador; el mapeo queda guardado en
  `school_aliases`.
- ~~**`Brown` vs `Brown - Drop Off`**.~~ Mismo colegio, otro modo de llegada: esas
  filas traen `Bus = 'NO'`. Se parte en escuela + `arrival_mode`.
- ~~**Grado `0` contra `K`**.~~ **La ambigüedad no existe.** Al pasar el parser
  sobre el archivo, el `0` no aparece en **ninguna** de las 157 filas de chico:
  está en 55 filas del bloque de borrador y en los 2 renglones de leyenda. Los
  grados reales son `K` (35), `1` (35), `2` (27), `3` (36), `4` (21) y `5` (3).
  Queda en pie solo la parte del grado `5`, que el spec no lista pero es real.

### Abiertas

1. **Los chicos de las 3:00 no están en el roster.** R1 los define y las hojas de
   día los tienen, pero ninguna columna de día del roster trae un `3`. ¿De dónde
   sale ese grupo?
2. **`HG: Waiting on Paperwork` (11).** Hoy entran como los demás (y, como los
   `REMOVE`, no tienen días inscriptos). ¿Es lo correcto?
3. **Grado `5`**, que el spec no lista (`K, 1, 2, 3, 4`). Son 3 chicos reales.
   ¿Entran en las reglas de care como los de 4?
4. **`Online `** en la columna `Mon`. ¿Hay chicos remotos?
5. **El viernes no tiene hoja de Sign Out** y fusiona Classes con Care. ¿No se
   firma la salida los viernes?
6. **Dos contactos fijos.** ¿Alcanza con dos por chico? El modelo de la §4 usa
   `priority 1|2`, que lo deja cerrado en dos. Y falta decidir si el Contacto #2
   tiene cuenta en el portal: hoy se vincula si ya existe, pero no se crea.
7. **Hermanos.** No hay columna de familia: se detectan por `Email #1` igual, y
   son **31 de 157** (126 emails distintos). La columna `Notes` los menciona en
   texto libre.
8. **La columna `Medication (pg 4)` a veces trae el nombre del remedio** —un
   autoinyector, un antihistamínico— en vez de una tilde. Son 2 de 157. El
   parser lo lee como formulario presentado y guarda el texto en `raw_value`,
   así que esos dos chicos no caen en la lista de "debe papeles". **Pero el dato
   queda en la tabla de cumplimiento, que es administrativa: el counselor no la
   ve.** Un remedio que el chico toma tiene que llegar a la vista del counselor
   igual que la alergia. No se copió a `allergies` por cuenta propia — es dato
   médico y moverlo de columna es decisión de Heather, no del importador.
9. **Una fecha de nacimiento con el año incompleto** (tres dígitos en vez de
   cuatro). No hay lectura correcta posible: el parser la rechaza y la manda a
   revisión en vez de adivinar entre dos años. Es 1 de 157.

Y las cinco de la §7 del spec, que siguen abiertas tal cual: nombres completos de
las escuelas, si las clases de natación se modelan como clases normales, el
documento de *pickup locations* 2026-27, si el cobro por retiro tarde entra en
scope, y si hay cupos por clase y por sala.
