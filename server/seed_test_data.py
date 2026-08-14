"""
Seed script to create permanent test accounts:
  - Test Parent:    testparent@jclub.com / Test1234!
  - Test Counselor: testcounselor@jclub.com / Test1234!
  - 2 children registered to the test parent
  - Counselor assigned to the same school as the children

Run directly:
    python server/seed_test_data.py
(Requires DATABASE_URL environment variable to be set.)

Or trigger at app startup by setting SEED_TEST_ACCOUNTS=1 in the environment.
"""
import os
import sys

import bcrypt

sys.path.insert(0, os.path.dirname(__file__))
# Import through the package like every other module. `database` and
# `server.database` are two distinct module objects to Python, each with its
# own globals — including the organization the connection gets pinned to. The
# unqualified import gave this file a second copy whose organization was
# always unset, so every insert here was refused by the isolation policy.
try:
    from server.database import get_db
except ImportError:  # running the script directly from inside server/
    from database import get_db

PASSWORD = 'Test1234!'
PARENT_EMAIL = 'testparent@jclub.com'
COUNSELOR_EMAIL = 'testcounselor@jclub.com'


def seed_test_accounts(verbose=True):
    """Create (idempotently) the test parent, test counselor, school, and children.

    Safe to call repeatedly: existing rows are reused instead of duplicated.
    Returns a dict with the created credentials and school name.
    """
    def log(msg):
        if verbose:
            print(msg)

    pw_hash = bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt()).decode()
    db = get_db()
    try:
        # 1. Ensure a school exists (create "Test School" if none available)
        school = db.execute("SELECT id, name FROM schools LIMIT 1").fetchone()
        if not school:
            db.execute("INSERT INTO schools (name) VALUES ('Test School')")
            db.commit()
            school = db.execute(
                "SELECT id, name FROM schools WHERE name = 'Test School'"
            ).fetchone()

        school_id = school['id']
        school_name = school['name']
        log(f"Using school: {school_name} (id={school_id})")

        # 2. Create test parent
        existing = db.execute(
            "SELECT id FROM users WHERE email = %s", (PARENT_EMAIL,)
        ).fetchone()
        if existing:
            parent_id = existing['id']
            log(f"Test parent already exists (id={parent_id})")
        else:
            db.execute(
                "INSERT INTO users (email, password_hash, role, name, phone) "
                "VALUES (%s, %s, 'parent', %s, %s)",
                (PARENT_EMAIL, pw_hash, 'Test Parent', '555-0001'),
            )
            db.commit()
            parent_id = db.execute(
                "SELECT id FROM users WHERE email = %s", (PARENT_EMAIL,)
            ).fetchone()['id']
            log(f"Created test parent (id={parent_id})")

        # 3. Create test counselor
        existing = db.execute(
            "SELECT id FROM users WHERE email = %s", (COUNSELOR_EMAIL,)
        ).fetchone()
        if existing:
            counselor_id = existing['id']
            log(f"Test counselor already exists (id={counselor_id})")
        else:
            db.execute(
                "INSERT INTO users (email, password_hash, role, name, phone) "
                "VALUES (%s, %s, 'counselor', %s, %s)",
                (COUNSELOR_EMAIL, pw_hash, 'Test Counselor', '555-0002'),
            )
            db.commit()
            counselor_id = db.execute(
                "SELECT id FROM users WHERE email = %s", (COUNSELOR_EMAIL,)
            ).fetchone()['id']
            log(f"Created test counselor (id={counselor_id})")

        # 4. Assign counselor to the school
        existing = db.execute(
            "SELECT counselor_id FROM counselor_schools "
            "WHERE counselor_id = %s AND school_id = %s",
            (counselor_id, school_id),
        ).fetchone()
        if not existing:
            db.execute(
                "INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)",
                (counselor_id, school_id),
            )
            db.commit()
            log(f"Assigned counselor to school '{school_name}'")
        else:
            log(f"Counselor already assigned to school '{school_name}'")

        # 5. Create 2 children for the test parent
        children_data = [
            ('Sofia Test', 'Full Service'),
            ('Daniel Test', 'Full Service'),
        ]
        for child_name, service_type in children_data:
            existing = db.execute(
                "SELECT id FROM children WHERE name = %s AND parent_id = %s",
                (child_name, parent_id),
            ).fetchone()
            if existing:
                child_id = existing['id']
                log(f"Child '{child_name}' already exists (id={child_id})")
            else:
                db.execute(
                    "INSERT INTO children (name, parent_id, school_id, service_type, active) "
                    "VALUES (%s, %s, %s, %s, 1)",
                    (child_name, parent_id, school_id, service_type),
                )
                db.commit()
                child_id = db.execute(
                    "SELECT id FROM children WHERE name = %s AND parent_id = %s",
                    (child_name, parent_id),
                ).fetchone()['id']
                log(f"Created child '{child_name}' (id={child_id})")

            for day in ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']:
                db.execute(
                    "INSERT INTO registrations (child_id, day_of_week) "
                    "VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (child_id, day),
                )
            db.commit()
            log(f"  Registered '{child_name}' for Mon-Fri")

        if verbose:
            print("\n=== Test Accounts Ready ===")
            print(f"  Parent:    {PARENT_EMAIL}    / {PASSWORD}")
            print(f"  Counselor: {COUNSELOR_EMAIL} / {PASSWORD}")
            print(f"  Children:  Sofia Test, Daniel Test @ {school_name}")

        return {
            'parent_email': PARENT_EMAIL,
            'counselor_email': COUNSELOR_EMAIL,
            'password': PASSWORD,
            'school': school_name,
        }
    finally:
        db.close()


if __name__ == '__main__':
    seed_test_accounts(verbose=True)
