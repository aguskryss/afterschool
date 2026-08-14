/**
 * KIKAR wordmark.
 *
 * Rendered typographically (Raleway, wide tracking) as a faithful stand-in for
 * the real logo. The actual mark has custom letterforms — the detached vertical
 * bar and chevron arms on the K — that can't be reproduced accurately without
 * the vector source. Drop the real file in and swap the body of this one
 * component; nothing else in the app references the logo directly.
 */
export function Wordmark({
  className = '',
  tone = 'ink',
}: {
  className?: string
  tone?: 'ink' | 'sand' | 'inherit'
}) {
  const color =
    tone === 'ink' ? 'text-ink-900' : tone === 'sand' ? 'text-sand-400' : ''
  return (
    <span
      className={`font-brand font-light tracking-[0.34em] leading-none select-none ${color} ${className}`}
    >
      KIKAR
    </span>
  )
}

/**
 * What a signed-in user sees where the wordmark used to be.
 *
 * WHITE-LABEL: an organization with a logo gets *only* their logo. Kikar is
 * the platform, not the product these parents think they are using — the app
 * is the JCC's afternoon programme, and every screen saying otherwise makes it
 * feel like someone else's software.
 *
 * Falls back to the Kikar wordmark, which is the right answer in all three
 * cases that produce no logo: an organization that has not uploaded one, a
 * superadmin (who belongs to no organization), and a Supabase that is
 * misconfigured so the URL could not be built.
 *
 * NOT ON THE LOGIN SCREEN, and it cannot be. Login is unified and there is no
 * per-organization subdomain, so until the credentials come back the server
 * does not know which JCC is at the keyboard. That screen keeps Lockup.
 */
export function OrgLogo({
  org,
  className = '',
}: {
  org: { name: string; logo_url: string | null } | null
  className?: string
}) {
  if (org?.logo_url) {
    return (
      <img
        src={org.logo_url}
        alt={org.name}
        // Constrained by height so wide and square marks both sit correctly on
        // a 3.5rem bar; width follows the aspect ratio.
        className={`max-h-8 w-auto max-w-[11rem] object-contain object-left ${className}`}
      />
    )
  }
  return <Wordmark className={`text-base ${className}`} />
}

export function Lockup({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex flex-col gap-1.5 ${className}`}>
      <Wordmark className="text-2xl" />
      <span className="text-[0.6rem] font-medium uppercase tracking-[0.3em] text-ink-500">
        Afterschool
      </span>
    </span>
  )
}
