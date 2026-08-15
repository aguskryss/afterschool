"""Module access tests.

Modules are the billing boundary: a JCC pays for what its toggles turn on. The
property these tests protect is that the boundary is *complete* — every /api
route either belongs to a module or is deliberately core. A route that belongs
to a paid module but sits outside the map is given away for free, silently.

This reads app.py as text rather than importing it, because importing the app
runs init_db() and needs a live database. Route coverage is a static property;
it should be checkable without one.

    python3 tests/test_module_access.py
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import tenancy

APP_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server', 'app.py'
)

# Routes that are the product itself, not a module: attendance and rosters,
# authentication, the admin's people and school management, exports of core
# data, and the platform console (which is superadmin-only and never gated).
#
# Adding a route here is a decision to give it to every JCC. That is often
# right — it should just be deliberate.
CORE_PREFIXES = (
    '/api/health',
    # Which events notify parents, and when the daily attendance ask goes out.
    # Core rather than tied to a module because the switches span several of
    # them at once: an organization with broadcasts off still notifies about
    # pickups, and gating the screen on any one module would hide the controls
    # for the others. Each individual event stays gated where it is raised.
    '/api/admin/notification-settings',
    # Driven by an external scheduler, so it carries no JWT and no organization
    # — it decides which organizations are due. Guarded by CRON_SECRET instead,
    # and closed when that is unset.
    '/api/cron/run-due',
    # Name, logo and colours for the sign-in screen. No token yet, so no
    # organization to gate on — it is the one thing an anonymous visitor may
    # read, and none of it is sensitive.
    '/api/public/branding',
    '/api/auth/login',
    '/api/auth/context',
    '/api/auth/refresh',
    '/api/auth/check',
    '/api/auth/change-password',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/parent/children',
    '/api/parent/notifications',
    '/api/parent/stream',
    '/api/counselor/roster',
    '/api/counselor/attendance',
    # Recording where a child is, which is the same act as the attendance tap
    # and belongs to the same side of the billing boundary.
    '/api/counselor/child-status',
    '/api/counselor/notify-parent',
    '/api/counselor/notification-responses',
    '/api/admin/stats',
    '/api/admin/schools',
    # The menu a child's grade is picked from — same footing as schools, one
    # JCC-wide list every admin screen reads.
    '/api/admin/grades',
    '/api/admin/counselors',
    # Who covers which school, and the log of who changed it. Core for the
    # same reason the roster is: a JCC cannot run an afternoon without it.
    '/api/admin/counselor-assignments',
    '/api/admin/parents',
    '/api/admin/children',
    '/api/admin/admins',
    '/api/admin/attendance',
    '/api/admin/upload-roster',
    '/api/admin/child-search',
    '/api/admin/export/attendance',
    '/api/admin/export/roster',
    '/api/admin/end-of-year',
    '/api/admin/wipe-all-data',
    '/api/admin/demo-status',
    '/api/admin/demo-token',
    '/api/superadmin/',
)

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected}, got {actual}")
    if not ok:
        failures.append(label)


def declared_routes() -> list[str]:
    with open(APP_PY, encoding='utf-8') as fh:
        source = fh.read()
    # Both @app.route('/api/...') and the superadmin blueprint's @bp.route.
    return sorted(set(re.findall(r"@\w+\.route\(\s*'(/api/[^']*)'", source)))


def main() -> int:
    routes = declared_routes()
    check('routes found in app.py', len(routes) > 50, True)

    # 1. Every route is either mapped to a module or explicitly core.
    uncovered = [
        r for r in routes
        if tenancy.module_for_path(r) is None
        and not any(r.startswith(p) for p in CORE_PREFIXES)
    ]
    if uncovered:
        print('\n  Routes that are neither module-gated nor listed as core:')
        for r in uncovered:
            print(f'    {r}')
        print('  Add each to tenancy.MODULE_ROUTES or to CORE_PREFIXES here.\n')
    check('every /api route has a module decision', uncovered, [])

    # 2. Every module in the catalogue actually gates something. A module with
    #    no routes is a toggle that sells nothing — either the routes are
    #    missing from the map or the module isn't built yet.
    mapped = {key for _prefix, key in tenancy.MODULE_ROUTES}
    unbuilt = sorted(set(tenancy.MODULES) - mapped)
    print(f"\n  Modules with no routes yet (expected while being built): {unbuilt}\n")

    # 3. Every key in the route map is a real module. A typo here fails open
    #    in module_enabled(), which returns False for unknown keys — so it
    #    would lock a JCC out of something it paid for.
    unknown = sorted(mapped - set(tenancy.MODULES))
    check('no route maps to an unknown module', unknown, [])

    # 4. Longest-prefix resolution: the exports live under a module even though
    #    /api/admin/export/ as a whole is core.
    check(
        'absences export resolves to the absences module',
        tenancy.module_for_path('/api/admin/export/absences'),
        'absences',
    )
    check(
        'attendance export stays core',
        tenancy.module_for_path('/api/admin/export/attendance'),
        None,
    )
    check(
        'attendance itself stays core',
        tenancy.module_for_path('/api/counselor/attendance'),
        None,
    )

    # The two pickup modules are sold separately and their routes sit one
    # character apart. Getting this wrong hands a JCC the module it didn't buy
    # and refuses the one it did, so it is pinned rather than trusted.
    check(
        'the authorized-person release belongs to secure_pickup',
        tenancy.module_for_path('/api/counselor/pickup/release'),
        'secure_pickup',
    )
    check(
        'the announce-then-claim queue stays on pickups',
        tenancy.module_for_path('/api/counselor/pickup-alerts'),
        'pickups',
    )
    check(
        "the parent's arrival ping stays on pickups",
        tenancy.module_for_path('/api/parent/pickup'),
        'pickups',
    )
    check(
        "the parent's authorized list belongs to secure_pickup",
        tenancy.module_for_path('/api/parent/authorized-pickups'),
        'secure_pickup',
    )

    # 5. Unknown keys fail closed, known-but-unset keys fall back to default.
    check('unknown module is off', tenancy.module_enabled({'nope': True}, 'nope'), False)
    check(
        'new modules are off by default',
        tenancy.module_enabled({}, 'photos'),
        False,
    )
    check(
        'an explicit override wins over the default',
        tenancy.module_enabled({'photos': True}, 'photos'),
        True,
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All module access checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
