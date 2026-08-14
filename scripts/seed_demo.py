"""A program's worth of demo data — enough to actually look at the app.

`seed_test_data.py` makes two children so a developer can sign in.
This makes a program: four schools, eighteen families, thirty days of
attendance with uneven turnout, activity rosters with a quarter of the
counselor slots deliberately left open, make-up bookings still ahead,
conversations mid-thread, and closures on the calendar. Screens that look
correct against two rows often fall apart against four hundred.

Everything it writes is tagged so it can be taken out again:
  - people      -> email ends in @demo.kikarlabs.com
  - schools     -> names in DEMO_SCHOOLS
  - activities  -> names in DEMO_ACTIVITIES
  - calendar    -> description = 'demo'
  - photos      -> caption starts with '[demo]' (uploaded separately)
Re-running clears the previous set first, and the RNG is seeded, so the same
program comes back rather than a second one piling up.

The accounts it creates cannot be signed into: the password hash is bcrypt of
a random salt, so `checkpw` returns False for everything rather than raising.
This data is for looking at.

    .venv/bin/python scripts/seed_demo.py "$DATABASE_URL"

To remove it, run it and then delete — or just:
    DELETE FROM users WHERE email LIKE '%@demo.kikarlabs.com';
(children, attendance and the rest cascade or are cleaned on the next run.)
"""

import bcrypt
import random
import sys
from datetime import date, datetime, timedelta

import psycopg2
import psycopg2.extras

ORG = 1
DEMO_DOMAIN = '@demo.kikarlabs.com'

DEMO_SCHOOLS = [
    ('Beth David Elementary', 'elementary'),
    ('Hillel Community Day', 'elementary'),
    ('Scheck Hillel Middle', 'middle'),
    ('Temple Beth Am Day', 'elementary'),
]

DEMO_ACTIVITIES = [
    ('Swim', 'Sports', 'Aquatics'),
    ('Basketball', 'Sports', 'Court'),
    ('Robotics Club', 'STEM', None),
    ('Art Studio', 'Arts', None),
    ('Soccer', 'Sports', 'Field'),
    ('Chess Club', 'Enrichment', None),
]

FAMILIES = [
    ('Ariel Mizrahi', ['Noa Mizrahi', 'Ilan Mizrahi']),
    ('Dana Levin', ['Maya Levin']),
    ('Yosef Abravanel', ['Eitan Abravanel', 'Tamar Abravanel']),
    ('Rivka Toledano', ['Shira Toledano']),
    ('Marcos Benhamu', ['Daniel Benhamu', 'Sofia Benhamu']),
    ('Sarah Cohen-Ruiz', ['Lior Cohen-Ruiz']),
    ('Ezra Nahmias', ['Gabriel Nahmias']),
    ('Talia Serfaty', ['Yael Serfaty', 'Adam Serfaty']),
    ('Jonathan Peretz', ['Micha Peretz']),
    ('Michal Azoulay', ['Ruth Azoulay']),
    ('David Sasson', ['Elias Sasson', 'Nina Sasson']),
    ('Orly Benzaquen', ['Ari Benzaquen']),
    ('Isaac Bitton', ['Leah Bitton']),
    ('Naomi Hazan', ['Omer Hazan', 'Dalia Hazan']),
    ('Ruben Chocron', ['Alma Chocron']),
    ('Esther Garzon', ['Jonah Garzon']),
    ('Alberto Pinto', ['Clara Pinto', 'Max Pinto']),
    ('Yael Amsellem', ['Roi Amsellem']),
]

COUNSELORS = ['Maria Fuentes', 'Josh Kaplan', 'Camila Restrepo']

SERVICE_TYPES = ['Full week', 'Three days', 'Two days']
RELEASE_GROUPS = ['Bus', 'Car line', 'Walker']
WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']


def main(url: str) -> None:
    rnd = random.Random(20260802)  # fixed, so a re-run rebuilds the same program
    conn = psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SELECT set_config('app.organization_id', %s, false)", (str(ORG),))
    cur.execute("SELECT set_config('app.is_superadmin', 'off', false)")

    # ── Clear any previous demo run ─────────────────────────────────────
    cur.execute(
        "SELECT id FROM users WHERE email LIKE %s", ('%' + DEMO_DOMAIN,)
    )
    old_users = [r['id'] for r in cur.fetchall()]
    if old_users:
        cur.execute("SELECT id FROM children WHERE parent_id = ANY(%s)", (old_users,))
        old_kids = [r['id'] for r in cur.fetchall()]
        if old_kids:
            for t in ('photo_tags', 'attendance_records', 'absences',
                      'authorized_pickup_people', 'registrations', 'pickup_releases'):
                cur.execute(f"DELETE FROM {t} WHERE child_id = ANY(%s)", (old_kids,))
            cur.execute("DELETE FROM children WHERE id = ANY(%s)", (old_kids,))
        cur.execute("DELETE FROM thread_messages WHERE thread_id IN "
                    "(SELECT id FROM parent_threads WHERE parent_id = ANY(%s))", (old_users,))
        cur.execute("DELETE FROM parent_threads WHERE parent_id = ANY(%s)", (old_users,))
        cur.execute("DELETE FROM counselor_schools WHERE counselor_id = ANY(%s)", (old_users,))
        cur.execute("DELETE FROM users WHERE id = ANY(%s)", (old_users,))
    cur.execute("DELETE FROM activity_roster WHERE activity_id IN "
                "(SELECT id FROM activities WHERE name = ANY(%s))",
                ([a[0] for a in DEMO_ACTIVITIES],))
    cur.execute("DELETE FROM activities WHERE name = ANY(%s)",
                ([a[0] for a in DEMO_ACTIVITIES],))
    cur.execute("DELETE FROM activity_schedules WHERE activity_name_pattern = ANY(%s)",
                ([a[0] for a in DEMO_ACTIVITIES],))
    cur.execute("DELETE FROM schools WHERE name = ANY(%s)",
                ([s[0] for s in DEMO_SCHOOLS],))
    cur.execute("DELETE FROM calendar_events WHERE description = 'demo'")

    # Nobody signs in as these. A real bcrypt hash of a random secret keeps the
    # login path from raising on a malformed hash while leaving the account
    # unreachable — this data is for looking at, not for logging into.
    dead_hash = bcrypt.hashpw(
        bcrypt.gensalt(rounds=4), bcrypt.gensalt(rounds=4)
    ).decode()

    def user(name, role):
        email = name.lower().replace(' ', '.').replace("'", '') + DEMO_DOMAIN
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name, organization_id, "
            "password_set_at, invited_at, is_new) "
            "VALUES (%s,%s,%s,%s,%s, NOW(), NOW(), 0) RETURNING id",
            (email, dead_hash, role, name, ORG),
        )
        return cur.fetchone()['id']

    # ── Schools ─────────────────────────────────────────────────────────
    schools = {}
    for name, division in DEMO_SCHOOLS:
        cur.execute(
            "INSERT INTO schools (name, division_type, organization_id) "
            "VALUES (%s,%s,%s) RETURNING id", (name, division, ORG))
        schools[name] = cur.fetchone()['id']
    school_ids = list(schools.values())

    # ── Counselors, each covering two schools ───────────────────────────
    counselor_ids = []
    for i, name in enumerate(COUNSELORS):
        cid = user(name, 'counselor')
        counselor_ids.append(cid)
        for sid in (school_ids[i % 4], school_ids[(i + 1) % 4]):
            cur.execute(
                "INSERT INTO counselor_schools (counselor_id, school_id, organization_id) "
                "VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", (cid, sid, ORG))

    # ── Families ────────────────────────────────────────────────────────
    kids = []          # (child_id, name, school_id, school_name, parent_id)
    parent_ids = []
    for parent_name, child_names in FAMILIES:
        pid = user(parent_name, 'parent')
        parent_ids.append(pid)
        for child_name in child_names:
            school_name = rnd.choice(list(schools))
            sid = schools[school_name]
            service = rnd.choice(SERVICE_TYPES)
            cur.execute(
                "INSERT INTO children (name, parent_id, school_id, service_type, "
                "release_group, active, is_new, organization_id) "
                "VALUES (%s,%s,%s,%s,%s,1,0,%s) RETURNING id",
                (child_name, pid, sid, service, rnd.choice(RELEASE_GROUPS), ORG))
            kid = cur.fetchone()['id']
            kids.append((kid, child_name, sid, school_name, pid))
            days = (WEEKDAYS if service == 'Full week'
                    else rnd.sample(WEEKDAYS, 3 if service == 'Three days' else 2))
            for d in sorted(days, key=WEEKDAYS.index):
                cur.execute(
                    "INSERT INTO registrations (child_id, day_of_week, organization_id) "
                    "VALUES (%s,%s,%s)", (kid, d, ORG))

    # ── Thirty days of attendance, weekdays only ────────────────────────
    today = date.today()
    counselor_pool = counselor_ids or [None]
    attendance_rows = 0
    absence_rows = 0
    for back in range(30, 0, -1):
        day = today - timedelta(days=back)
        if day.weekday() > 4:
            continue
        # A real program does not run at a flat rate; some days are thin.
        turnout = rnd.uniform(0.62, 0.94)
        for kid, _name, sid, _sname, _pid in kids:
            if rnd.random() > turnout:
                if rnd.random() < 0.35:
                    cur.execute(
                        "INSERT INTO absences (child_id, absence_date, marked_by, "
                        "organization_id) VALUES (%s,%s,%s,%s)",
                        (kid, day.isoformat(), _pid, ORG))
                    absence_rows += 1
                continue
            checked_in = datetime.combine(day, datetime.min.time()) + timedelta(
                hours=15, minutes=rnd.randint(0, 25))
            checked_out = checked_in + timedelta(hours=2, minutes=rnd.randint(5, 55))
            cur.execute(
                "INSERT INTO attendance_records (child_id, school_id, attendance_date, "
                "on_bus, submitted_by, submitted_at, checked_in_at, checked_out_at, "
                "organization_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (kid, sid, day.isoformat(), 1, rnd.choice(counselor_pool),
                 checked_in, checked_in, checked_out, ORG))
            attendance_rows += 1

    # Today, half the program is still on site — so the live headcount moves.
    for kid, _n, sid, _s, _p in kids:
        if rnd.random() < 0.7:
            cin = datetime.combine(today, datetime.min.time()) + timedelta(
                hours=15, minutes=rnd.randint(0, 25))
            still_here = rnd.random() < 0.5
            cur.execute(
                "INSERT INTO attendance_records (child_id, school_id, attendance_date, "
                "on_bus, submitted_by, submitted_at, checked_in_at, checked_out_at, "
                "organization_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (kid, sid, today.isoformat(), 1, rnd.choice(counselor_pool), cin, cin,
                 None if still_here else cin + timedelta(hours=2), ORG))
            attendance_rows += 1

    # ── Activities and their rosters ────────────────────────────────────
    act_ids = {}
    for name, category, sub in DEMO_ACTIVITIES:
        cur.execute(
            "INSERT INTO activities (name, category, sub_type, season, organization_id) "
            "VALUES (%s,%s,%s,'Fall 2026',%s) RETURNING id", (name, category, sub, ORG))
        act_ids[name] = cur.fetchone()['id']
        for d in rnd.sample(WEEKDAYS, 2):
            cur.execute(
                "INSERT INTO activity_schedules (activity_name_pattern, day_of_week, "
                "dropoff_time, pickup_time, organization_id) VALUES (%s,%s,%s,%s,%s)",
                (name, d, '15:30', '17:00', ORG))

    roster_rows = 0
    for name, aid in act_ids.items():
        for kid, child_name, _sid, school_name, _pid in rnd.sample(kids, rnd.randint(8, 14)):
            day = rnd.choice(WEEKDAYS)
            for action, t in (('Drop Off', '15:30'), ('Pick Up', '17:00')):
                # A quarter left unassigned on purpose, so "needs a counselor"
                # and the bulk-assign have something to act on.
                assigned = None if rnd.random() < 0.25 else rnd.choice(counselor_pool)
                cur.execute(
                    "INSERT INTO activity_roster (activity_id, child_name, school, "
                    "action, day_of_week, action_time, assigned_counselor_id, season, "
                    "source, organization_id) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,'Fall 2026','upload',%s)",
                    (aid, child_name, school_name, action, day, t, assigned, ORG))
                roster_rows += 1

    # ── Make-up classes parents booked, all still ahead ──────────────────
    makeups = 0
    for kid, child_name, _sid, school_name, pid in rnd.sample(kids, 7):
        when = today + timedelta(days=rnd.randint(1, 12))
        name = rnd.choice(list(act_ids))
        cur.execute(
            "INSERT INTO activity_roster (activity_id, child_name, school, action, "
            "day_of_week, action_time, specific_date, season, source, "
            "requested_by_parent_id, parent_will_pickup, counselor_locked, "
            "admin_seen_at, assigned_counselor_id, organization_id) "
            "VALUES (%s,%s,%s,'Pick Up',%s,'17:00',%s,'Fall 2026','parent_makeup',"
            "%s,%s,FALSE,NULL,%s,%s)",
            (act_ids[name], child_name, school_name, when.strftime('%A'), when,
             pid, rnd.random() < 0.5,
             None if rnd.random() < 0.6 else rnd.choice(counselor_pool), ORG))
        makeups += 1

    # ── Who is allowed to collect a child ───────────────────────────────
    pickups = 0
    for kid, child_name, _sid, _sn, _pid in rnd.sample(kids, 20):
        surname = child_name.split(' ', 1)[1]
        for who, rel in rnd.sample(
            [(f'Rachel {surname}', 'Grandmother'), (f'Simon {surname}', 'Grandfather'),
             (f'Laura {surname}', 'Aunt'), (f'Nanny — Gloria P.', 'Nanny')], 2):
            cur.execute(
                "INSERT INTO authorized_pickup_people (child_id, name, relationship, "
                "organization_id) VALUES (%s,%s,%s,%s)", (kid, who, rel, ORG))
            pickups += 1

    # ── Conversations with the office ───────────────────────────────────
    threads = 0
    convos = [
        ("Hi! Noa has a dentist appointment Thursday, she'll be picked up at 4.",
         "Thanks for letting us know — I've noted it for Thursday."),
        ("Is the program running on the 14th? I saw something about a closure.",
         "We're closed the 14th. It's on the calendar in your app."),
        ("Can my mother pick up on Fridays? She's on the authorized list.",
         None),
        ("Eitan forgot his water bottle yesterday, blue with stickers.",
         "Found it — it's in the front office, ask for me at pickup."),
        ("Could we add swimming for Tamar next semester?", None),
    ]
    for (first, reply), pid in zip(convos, rnd.sample(parent_ids, len(convos))):
        cur.execute("SELECT name FROM users WHERE id = %s", (pid,))
        pname = cur.fetchone()['name']
        unread = 0 if reply else 1
        cur.execute(
            "INSERT INTO parent_threads (parent_id, last_message_at, parent_unread, "
            "admin_unread, organization_id) VALUES (%s, NOW(), 0, %s, %s) RETURNING id",
            (pid, unread, ORG))
        tid = cur.fetchone()['id']
        threads += 1
        cur.execute(
            "INSERT INTO thread_messages (thread_id, sender_id, sender_role, "
            "sender_name, body, created_at, organization_id) "
            "VALUES (%s,%s,'parent',%s,%s, NOW() - INTERVAL '2 hours', %s)",
            (tid, pid, pname, first, ORG))
        if reply:
            cur.execute(
                "INSERT INTO thread_messages (thread_id, sender_id, sender_role, "
                "sender_name, body, created_at, organization_id) "
                "VALUES (%s,NULL,'admin','Front office',%s, NOW() - INTERVAL '1 hour', %s)",
                (tid, reply, ORG))

    # ── Calendar ────────────────────────────────────────────────────────
    events = [
        (today + timedelta(days=6), 'closed', 'No program — teacher planning day'),
        (today + timedelta(days=14), 'closed', 'Sukkot — building closed'),
        (today + timedelta(days=21), 'early_dismissal', 'Early dismissal, 4:00pm'),
        (today + timedelta(days=33), 'mini_camp', 'Mini camp — full day'),
    ]
    for when, kind, title in events:
        cur.execute(
            "INSERT INTO calendar_events (event_date, event_type, title, description, "
            "organization_id) VALUES (%s,%s,%s,'demo',%s)",
            (when.isoformat(), kind, title, ORG))

    conn.commit()

    print(f"  schools             {len(schools)}")
    print(f"  parents             {len(parent_ids)}")
    print(f"  counselors          {len(counselor_ids)}")
    print(f"  children            {len(kids)}")
    print(f"  attendance records  {attendance_rows}")
    print(f"  absences            {absence_rows}")
    print(f"  activities          {len(act_ids)}")
    print(f"  roster entries      {roster_rows}")
    print(f"  make-up requests    {makeups}")
    print(f"  authorized pickups  {pickups}")
    print(f"  conversations       {threads}")
    print(f"  calendar events     {len(events)}")
    conn.close()


if __name__ == '__main__':
    main(sys.argv[1])
