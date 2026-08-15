import Swal from 'sweetalert2'

/**
 * One themed SweetAlert2 instance instead of a `Swal.fire({...})` with the
 * same seven style options copy-pasted at every call site. Colours and
 * radius come from theme.css rather than being restated here, so a rebrand
 * (see web/src/styles/theme.css) reaches these popups without a second edit.
 */
const themed = Swal.mixin({
  confirmButtonColor: 'var(--color-berry-500)',
  cancelButtonColor: '#cbd5e1',
  reverseButtons: true,
  customClass: { popup: 'font-sans' },
})

/**
 * "Are you sure?" before an action that cannot be undone from the UI.
 *
 * Resolves true only on an explicit confirm — dismissing with Escape, the
 * backdrop or Cancel all resolve false, so a caller can always just `if
 * (await confirmDelete(...))`.
 */
export async function confirmDelete(
  what: string,
  detail?: string,
): Promise<boolean> {
  const result = await themed.fire({
    title: `Delete ${what}?`,
    text: detail ?? 'This cannot be undone.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: `Delete ${what}`,
    cancelButtonText: 'Cancel',
  })
  return result.isConfirmed
}

/** A lighter confirm for a reversible or lower-stakes action. */
export async function confirmAction(
  title: string,
  detail?: string,
  confirmButtonText = 'Continue',
): Promise<boolean> {
  const result = await themed.fire({
    title,
    text: detail,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText: 'Cancel',
    confirmButtonColor: 'var(--color-sky-500)',
  })
  return result.isConfirmed
}

/** A brief, self-dismissing toast for "it worked" — no button, no wait. */
export function notifySuccess(title: string): void {
  void Swal.fire({
    title,
    icon: 'success',
    toast: true,
    position: 'top-end',
    timer: 2200,
    showConfirmButton: false,
    customClass: { popup: 'font-sans' },
  })
}

/**
 * The server said no — an admin trying to delete the last admin, a school
 * with children still on it. Stays on screen until dismissed, unlike the
 * success toast: the reason for the refusal is the point.
 */
export function notifyError(title: string, detail?: string): void {
  void themed.fire({
    title,
    text: detail,
    icon: 'error',
    confirmButtonColor: 'var(--color-sky-500)',
    confirmButtonText: 'OK',
  })
}
