# Feature parity audit — screen by screen

> **DESACTUALIZADO — no lo uses para decidir qué falta.** Se escribió antes de
> que se reconstruyeran las invitaciones masivas, el upload de roster, los
> exports, el 2FA, las actividades, los mensajes y el resto. Lista como MISSING
> cosas que existen hace tiempo, así que te va a mandar a construir de nuevo lo
> que ya está.
>
> Para saber qué falta de verdad, comparar los endpoints que usa cada app —
> el script está en [`handoff.md`](./handoff.md) → *El admin legacy*.

Built by enumerating every `onclick` handler and rendered control in the three
legacy portals (`public/admin/index.html`, and `public/parent` /
`public/counselor` recovered from git at `951ed6a`), then checking each one
against the Kikar SPA.

Legend: **OK** rebuilt · **PARTIAL** present but thinner · **MISSING** not in
the SPA at all · **DROPPED** deliberately not carried over.

---

## Parent portal

| Legacy capability | Handler | Status |
|---|---|---|
| Sign in | `doLogin` | **OK** — unified login |
| "I'm here for pickup" | `notifyPickup` | **OK** — one action for all children |
| Mark a one-off absence | `openAbsenceModal`, `submitAbsenceModal` | **OK** — via calendar |
| Remove a one-off absence | `removeAbsence` | **OK** — tap again |
| Recurring absences: view, add, remove | `showRecurringView`, `toggleRecurringForm`, `saveRecurring`, `removeRecurring`, `toggleDayLabel` | **MISSING** |
| Override a recurring day (attending / absent again) | `markAttending`, `markAbsentAgain` | **MISSING** |
| Make-up classes: browse options, book, cancel | `openMakeupModal`, `openMakeupModalForChild`, `toggleMakeupOption`, `submitMakeupClass`, `cancelMakeupGroup` | **MISSING** |
| Reply to "is your child coming today?" | `respondNotif` | **MISSING** |
| Inbox | `Message View` | **OK** |
| Change password | `doChangePw` | **OK** — Account |
| Enable push notifications | `enablePush`, `dismissPushBanner` | **MISSING** |
| Install as an app | `installApp`, `dismissInstall` | **MISSING** |

## Counselor portal

| Legacy capability | Handler | Status |
|---|---|---|
| Sign in | `doLogin` | **OK** |
| Pick a school, load its roster | `selectSchool`, `backToSchools`, `loadRoster` | **OK** — all assigned schools at once |
| Mark attendance | `toggleChildDone`, `submitAttendance` | **OK** — autosaves per tap instead of a submit button |
| Ask a parent to confirm attendance | `notifyParent` | **MISSING** |
| Activities: mode switch and group filter | `setActMode`, `setGroupFilter`, `showPortalTab` | **PARTIAL** — list and complete only |
| Day-off request: create, cancel | `openTimeOffModal`, `submitTimeOff`, `cancelTimeOff` | **OK** |
| Change password | `doChangePw` | **OK** |
| Enable / test push | `enablePush`, `testPush` | **MISSING** |
| Install as an app | `installApp` | **MISSING** |
| Release a claimed pickup | — (`/pickups/<id>/unclaim`) | **MISSING** |

## Admin portal

### Parents
| Legacy capability | Handler | Status |
|---|---|---|
| Search parents | — | **OK** |
| Add a parent | `openAddParentModal`, `addParent` | **MISSING** |
| **Send invitations to all uninvited parents** | `sendAllInvites` (+ progress poll) | **MISSING** |
| **Resend one parent's invitation** | `resendInvite` | **MISSING** |
| Invitation status per parent | rendered badge | **PARTIAL** — shows Invited/Active, but not *when* it was sent |
| Add a child to a parent | `openAddChildModal` | **MISSING** |
| Edit / delete a child | `deleteChild` | **MISSING** |
| Reactivate a removed child | `reactivateChild` | **MISSING** |
| Delete a parent | `deleteParent` | **MISSING** |

### Counselors
| Add a counselor | `openAddCounselorModal` | **MISSING** |
| **Resend invitation** | `resendCounselorInvite` | **MISSING** |
| Assign schools | `openAssignSchoolsModal`, `saveSchoolAssignment` | **MISSING** |
| Delete a counselor | `deleteCounselor` | **MISSING** |

### Admins
| Add an admin | `openAddAdminModal` | **MISSING** |
| **Resend invitation** | `resendAdminInvite` | **MISSING** |
| Delete an admin | `deleteAdmin` | **MISSING** |

### Schools
| Add a school | `openAddSchoolModal`, `addSchool` | **MISSING** |
| View a school's roster | `openSchoolRoster` | **MISSING** |

### Attendance & absences
| Attendance for a day | `loadAttendance` | **OK** |
| Week view | `loadWeekAttendance` | **MISSING** |
| Month heatmap | `loadMonthAttendance` | **MISSING** |
| Absences for a day | `loadAbsences` | **OK** |
| Export attendance / absences / roster to xlsx | `exportAttendance`, `exportAbsences`, `exportRoster` | **MISSING** |

### Calendar
| List events | — | **OK** |
| Add an event | `openAddEventModal`, `saveNewEvent` | **MISSING** |
| Delete an event | `deleteCalEvent` | **MISSING** |
| Month grid, day drill-down | `prevMonth`, `nextMonth`, `goToToday`, `openDayModal`, `saveDayEvent` | **MISSING** |
| Upload a calendar CSV + template | `downloadCalendarTemplate` | **MISSING** |

### Roster upload
| Upload a roster spreadsheet | `uploadRoster` | **MISSING** — still in legacy |
| Download the template | `downloadTemplate` | **MISSING** |

### Activities
| List activities | — | **OK** |
| Roster per activity, tabs | `showActTab` | **MISSING** |
| Assign a counselor, bulk assign | `assignBulkCounselor`, `clearBulkSelection` | **MISSING** |
| Manual entries: add, delete | `pickManualActivity`, `pickManualChild`, `saveManualEntry`, `deleteManualEntry` | **MISSING** |
| Activity schedules: save, delete | `saveSchedule`, `deleteSchedule` | **MISSING** |
| Review parent make-up requests | `deleteMakeupRequest`, unseen badge | **MISSING** |

### Day off requests
| Filter by status | `setTimeOffTab` | **OK** |
| Approve / reject | `approveTimeOffApplyTop`, `confirmRejectTimeOff` | **OK** |
| **See which roster entries an approval affects, and reassign them** | `openTimeOffReview`, `approveTimeOffWithSelections` | **MISSING** — the SPA approves blind |
| Reject with a note | `openRejectTimeOff` | **PARTIAL** — rejects without a note |
| Revert an approval | `revertTimeOff` | **MISSING** |

### Messages
| List sent messages | — | **OK** |
| Compose and send, with recipient preview | `sendAdminMessage`, `resetMsgForm`, `/messages/preview-count` | **MISSING** |

### Settings
| Change password | `doChangePw` | **OK** |
| 2FA status | — | **PARTIAL** — reports it, can't set up or disable |
| Enable push | `enablePush` | **MISSING** |
| End of school year | `openEndOfYear`, `doEndOfYear` | **MISSING** |
| Wipe all data | `openWipeAllData`, `doWipeAllData` | **MISSING** |

### Deliberately dropped
| Live demo launcher | `launchDemo` | **DROPPED** — tied to the old portals |
| Portal selector landing | — | **DROPPED** — replaced by unified login |
| `/api/auth/check` | — | **DROPPED** — a 401 plus refresh covers it |
| `/api/counselor/pickup-alerts` | — | **DROPPED** — the SSE stream supersedes it |

---

## Summary

**OK: 16 · PARTIAL: 5 · MISSING: 44 · DROPPED: 4**

The SPA runs the day. It cannot yet *administer* the program: no invitations,
no adding or removing anyone, no roster upload, no message composing, no
calendar editing, and no push. Push and invitations are the two that matter
most — without them a new family can never get into the app, and nobody's
phone ever rings.
