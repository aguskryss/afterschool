# JCCSN After-School App — Daily Operations Spec (from Heather's walkthrough, 8/3/2026)

> **Purpose of this document:** This is the functional spec for how JCCSN ("J Adventure") runs its after-school program day-to-day, reverse-engineered from (a) the Zoom walkthrough with Heather (program director), (b) her master roster file `J_Adv_Fall_Roster_2026-27.xlsx`, and (c) her weekly attendance workbook `6_15_26-6_19_26_-_Attendance.xlsx`. The app must replace both files. Heather builds the attendance workbook **manually every single day** — the app's core value is generating all of these views automatically from the roster + class enrollments.

---

## 1. Source files and what each one is

### File A — Master Roster (`J Adv Roster` sheet)
The season-long enrollment record. One row per child (duplicated rows allowed — see rule R4). This is what Heather uploads/maintains; everything else derives from it.

**Column map (exact, per Heather):**

| Col | Header | Meaning | Notes from meeting |
|---|---|---|---|
| A | ?? for parents | Billing person's notes | **IGNORE — not for the app** ("the first column you can completely ignore") |
| B | School | School the child attends | Important. Values seen: Brown, Glover, SPS, EHS, M-V (Village), D.O. (drop-off) |
| C | Child's Name | "Last, First" format | |
| D | Grade | K, 1, 2, 3, 4 | |
| E | Mon | **Dismissal time** on Monday (3, 4, 5, or 6) | Blank = not enrolled that day |
| F | M - Class | Monday class enrollment | **Hidden column** in her file; populated after class signups |
| G/H | Tue / T - Class | same pattern | |
| I/J | Wed / W - Class | same pattern | |
| K/L | Thur / R - Class | same pattern | |
| M/N | Fri / F - Class | same pattern | |
| O | Bus | `x` = rides the JCC bus | |
| P | Sex | M/F | |
| Q | Notes | Sibling/verification notes | |
| R | DOB | date | |
| S | B-Day Card | internal tracking | |
| T | Allergies | e.g. "Tree Nut (EpiPen)" | Surface prominently to staff |
| U–AC | Regist Rcvd, Regist Fee Chged, Member?, Pick up (pg 2), First Aid, Medication, Photo, Physical, Imm., complete | Registration/compliance checklist (dates or `x`) | Admin-only compliance tracker |
| AD–AI | Contact #1 (name/phone/email), Contact #2 (name/phone/email) | Parent contacts | These are the parent portal accounts |

There is also a `No Longer` sheet (same columns) = children who withdrew. App equivalent: soft-delete/archive with history.

### File B — Weekly Attendance Workbook
33 sheets: the same 6–7 views repeated per weekday (M/T/W/R/F prefixes). **These are the screens the app must generate automatically for each day.** Per-day views:

1. **{Day}-Staff** — staff schedule
2. **{Day}** (e.g. "Monday") — that day's child roster
3. **{Day} - Absent.Changes** — exceptions log by date
4. **{Day}-Bus** — bus pickup manifest grouped by school
5. **{Day} - Classes** — enrichment class rosters with dismissal routing
6. **{Day} - Care** — care room rosters with attendance checks
7. **{Day} - Sign Out** — parent sign-out sheet grouped by dismissal time

Friday collapses Classes+Care into one sheet (lighter day).

---

## 2. Core business rules (verbatim from the meeting — do not reinterpret)

**R1 — Four dismissal times: 3:00, 4:00, 5:00, 6:00 PM.** Every enrolled child has a dismissal time per day (the number in the roster's day column). 3:00 = bus kids who are walked over to Hillel next door ("BUS ONLY - EHS" in the sign-out sheet) and dismissed to them.

**R2 — Dismissal routing rule (the most important rule in the app):**
- If the child's **class ends at the same time as their dismissal time** → the **parent picks the child up directly from the class instructor**; the instructor handles sign-out. Roster shows `Dismiss To: PARENTS`.
- If the child's **class ends before their dismissal time** → the child returns to a **care room** until pickup. Roster shows `Dismiss To: {Room} - CARE`.
- Formal rule Heather confirmed: *dismissal time > class end time → child goes to care; dismissal time == class end time → dismissed to parents from class.*

> *Confirmed 2026-08-04:* **a class never ends after the child's dismissal time**, so R2 has exactly the two branches above and the routing engine has three (chained class → `PARENTS` → care room). A class session that violates it is a **data error, not a fourth branch** — the June workbook produces it 4 times. Surface it as a §6.3 warning and dismiss to `PARENTS`; never silently to care.

**R3 — Chained classes.** A child can take multiple classes in one day (e.g. 3:15–4:00 class, then 4:00–4:45 class, then care until 5:00 pickup). The "Dismiss To" of class 1 can be class 2 (e.g. `Soccer 3:15p-4p to Floor Hockey`). Her convention marks these kids with `**` next to the dismissal time.

**R4 — Multiple classes = duplicated roster rows.** When a child has 2+ classes on the same day, Heather duplicates the child's row with a different class in each. The app should accept this on import (dedupe children by name+school+grade, aggregate the class enrollments), but internally model it properly: **one child → many class enrollments per day.**

**R5 — Instructors are the same counselors.** No separate instructor sign-off is needed when a counselor drops kids at a class ("whoever is bringing the kids to the class is staying in the class"). No custody-transfer event between counselor and instructor.

**R6 — Sign-out happens ONLY on the staff device.** Parent signs on the **counselor's phone/tablet** at pickup. Heather explicitly does NOT want parents able to sign out from their own phone ("they could be picking up another kid somewhere else in the building… sign them out now but still leave them with us" → late-fee avoidance). This is a hard requirement.

**R7 — Care room assignment is by grade, admin-configurable.** Typical split: K (or K–1) in the smaller room ("Ocean"), older grades in the Gym; it varies with headcount. Agreed solution in the meeting: **admin can create named rooms and assign grade ranges to rooms** — not a fixed algorithm. Rooms seen: Ocean, Gym, Playground, WKL/WKR (rooms), Courts, Pool, Lower Field.

**R8 — Staff schedule is weekly-recurring with daily overrides.** "Theoretically every Monday should be the same… unless someone calls out and I have to move people around." Model: a weekly template per weekday + per-date overrides.

**R9 — Counselor personalized view replaces highlighting.** Today Heather prints all 4 pages for every counselor and manually highlights each person's assignments (bus route, class, care room per time block). The app must give each counselor a **"my day" view**: their bus route, the kids they pick up, where each kid goes, their class assignments (LEAD/ASSIST), and their care room per time block (3–4, 4–5, 5–6).

**R10 — Parent portal scope (keep it minimal):**
- Report absence / "my kid is (not) coming today" → feeds the Absent.Changes log
- See where their child is right now ("if it's not hard to do") — nice-to-have
- View group photos
- 1:1 messaging with the director
- Calendar
- **NOT** sign-out (see R6)
- Parents do NOT need live location tracking as a core feature; Heather sends a static "class X is in room Y" schedule today.

---

## 3. The daily views the app must generate (spec per screen)

All of these derive automatically from: master roster + class catalog + staff schedule + absence log. Heather should never assemble them by hand again.

### 3.1 Staff Schedule (per day)
Columns: Last, First, Hours (e.g. 1:30p–5p), Bus (route/school or n/a/office), 3p–4p assignment, 4p–5p, 5p–6p. Assignments include class name + role `(LEAD)`/`(ASSIST)`, care room + grade range (e.g. `Gym (1-4)`, `Ocean (K)`), or `Swim L/T`.

### 3.2 Daily Roster (per day)
Filter of master roster: only children enrolled that weekday. Columns: School, Child's Name, Grade, dismissal time (with `**` flag for multi-class), Class (with times, e.g. `Crafting 4p-4:45p`, or `NO CLASS`). Duplicated rows for multi-class kids.

### 3.3 Absent / Changes (per day)
Date-indexed log of exceptions: absences ("Charlotte C - absent") and one-off changes ("Add Asher Y to bus and swim"). In the app: absence reports from parents + admin-entered changes, shown as a dated feed and reflected everywhere else (bus manifest marks `A`, care sheets mark `A`, etc.).

### 3.4 Bus Manifest (per day)
Grouped by school pickup, each group headed by its assigned counselor(s) (e.g. "Brown Counselor: Fischer, Angelie"). Columns per child: Student, Grade, status `(X or A)` (X = picked up, A = absent), **"Where to?"** = the child's first destination after the bus (e.g. `Swim T - Pool`, `Bball - Courts`, `Gym - CARE`, `Tennis - Courts`). This is a tap-to-check attendance screen for the bus counselor.

### 3.5 Class Rosters (per day)
One block per class session. Block header: class name, time (3:15p–4p or 4p–4:45p), location, assigned staff. Columns per child: School, Name, Grade, Pick up (dismissal time), **Dismiss To** (computed via R2/R3: `PARENTS`, `{Room} - CARE`, or next class), Time Out, Initial. Time Out + Initial are only filled for kids dismissed to parents from the class (instructor collects signature per R2).

### 3.6 Care Rooms (per day)
One block per room/time-slot (e.g. "3p–4p Playground / Gym (2–4)"). Columns: School, Name, Grade, From/To Class (which class they came from or go to, or `NO CLASS`), Pick Up (dismissal time), plus periodic headcount check columns (3:00p, 3:30p → mark present/A). 

### 3.7 Sign-Out Sheet (per day)
Grouped by dismissal time (3 / 4 / 5 / 6 blocks). Columns: Child's Name, Grade, Class (last activity, `NO CLASS`, or `BUS ONLY - EHS`), Leaving @, Time Out, Initials. In the app this becomes the **counselor-device signature capture** (R6): counselor selects child → parent signs on screen → timestamp recorded automatically.

---

## 4. Data model implications

```
Child (name, school, grade, DOB, sex, allergies, bus_rider, notes, status: active/withdrawn)
Contact (child_id, name, phone, email, priority 1|2)  → parent portal accounts
Enrollment (child_id, weekday, dismissal_time ∈ {3,4,5,6})
ClassSession (name, weekday, start, end, location, capacity?)
ClassEnrollment (child_id, class_session_id)           ← many per child per day (R3/R4)
Room (name, capacity_hint)                             ← admin-managed (R7)
CareAssignmentRule (weekday?, time_block, grade_range → room)
Staff (name, hours per weekday)
StaffAssignment (staff_id, weekday, block ∈ {bus, 3-4, 4-5, 5-6}, ref → bus_route|class|room, role LEAD/ASSIST)
  + per-date override table (R8)
AbsenceChange (child_id, date, type: absent|change, note, source: parent|admin)
BusRoute (school → counselors)
AttendanceEvent (child_id, date, type: bus_pickup|care_check|class_checkin, status X|A, timestamp)
SignOut (child_id, date, signature_blob, timestamp, staff_device_id)   ← R6
ComplianceChecklist (child_id, items: registration, first_aid, medication, photo, physical, immunization…)
```

**Derived logic:** `Dismiss To` for any class enrollment = 
next chained class if one exists → else `PARENTS` if class.end == dismissal_time → else care room for (grade, time_block) per CareAssignmentRule.

---

## 5. Import requirements

- Accept Heather's roster **exactly as she sends it** (she was told not to change anything): tolerate the ignore-column A, hidden class columns F/H/J/L/N, duplicated rows for multi-class kids, `x` markers, mixed date/`x`/text in compliance columns, and `**` suffixes on dismissal times.
- Import should produce: Children, Contacts, Enrollments, ClassEnrollments, and flag rows needing review (e.g. missing dismissal time, unknown school code).

---

## 6. Admin configuration & UI views

### 6.1 What the admin (Heather) configures — everything else is derived

Setup, in dependency order:

1. **Class catalog** (per season): name, weekday, start/end time, location, optional capacity.
2. **Class enrollments**: assign children to classes; support multiple classes per child per day; auto-detect chaining (class A ends when class B starts → A's `Dismiss To` = B).
3. **Rooms**: free-form named rooms (`Ocean`, `Gym`, `Playground`, …). Admin-managed, never hardcoded (R7).
4. **Care assignment rules**: per weekday + time block (3–4p, 4–5p, 5–6p): grade range → room. Editable anytime; changes regenerate all derived views.
5. **Staff list**: counselors with available hours per weekday.
6. **Staff weekly template**: per counselor per weekday: bus route (or n/a), 3–4p assignment (class `LEAD`/`ASSIST` or care room), 4–5p, 5–6p (R8).
7. **Daily overrides**: one-off reassignments for a specific date without touching the template (staff call-outs).
8. **Bus routes**: school → assigned counselor(s), weekly template + daily override.

Once these 8 exist, the engine derives with zero manual work: `Dismiss To` per class enrollment, care room rosters per block, bus manifests, and sign-out sheets.

### 6.2 Counselor view (mobile) — "My Day"

Single timeline screen, personalized (replaces Heather's manual highlighting, R9):

- **Bus block**: their route, child list with tap-to-check attendance (`X`/`A`) and each child's "where to" destination.
- **Class block(s)**: their class roster with a destination chip per child — `CARE {room}`, `PARENTS {time}` (triggers signature capture at class end), or next class name.
- **Care block(s)**: their room's roster for that time block, with periodic attendance checks (e.g. 3:00p / 3:30p taps) and each child's from/to class.
- **Sign-out action**: select child → parent signs on the counselor's device → auto-timestamp (R6). Available in class blocks (`PARENTS` dismissals) **and** care blocks.

Counselors see only their own assignments, never the full system.

### 6.3 Admin view (desktop) — daily dashboard

Tabs mirror the current workbook (Staff / Roster / Absent-Changes / Bus / Classes / Care / Sign-Out) but fully generated. On top of the Excel parity:

- **Live headcounts per care rule**: each room×block row shows how many children land there today, so Heather can rebalance grade ranges when a room overflows (her stated decision driver).
- **Warnings**: unassigned staff slot after a call-out, child with no computable destination (missing dismissal time, class without room), room with no staff in a block, class over capacity.
- **One-click overrides**: mark staff absent → reassign for today only; mark child absent (or receive it from parent portal) → child drops from bus, class, care, and sign-out views in cascade, marked `A` for audit.
- **Live status board** (feeds R10 parent "where is my kid"): current computed location of every child based on the day's routing + attendance events.

---

## 7. Open questions for Heather (track in handoff)

1. Exact school code list and display names (Brown, Glover, SPS, EHS, Village, D.O. — confirm full names).
2. Swim lessons (Swim L/T, Pvt Swim) — treated as classes with external instructors? Same dismissal rules?
3. The "pickup locations" document she sent (class → room map for parents) — get final 2026–27 version.
4. Late pickup / late fee handling — she referenced parents avoiding extra charges; is late-fee tracking in scope?
5. Capacity limits per class/room?
