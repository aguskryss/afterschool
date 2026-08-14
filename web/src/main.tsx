import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import App from './App.tsx'
import { readSession } from './lib/auth'
import { refreshContext } from './lib/api'
import { applyBranding } from './lib/branding'

// Before the first paint: a returning user's saved organization colours the
// app immediately instead of appearing a frame later.
applyBranding(readSession()?.organization ?? null)

// Then catch up, in the background, on anything a superadmin changed since
// this session was created.
//
// refreshContext() has existed for a while and nothing called it, so branding
// and module changes only reached people who happened to sign out and back in.
// A logo upload that most users would not see for days is not a feature.
//
// Deliberately not awaited: the paint above already used the cached values, so
// this only matters when something changed, and a slow or failed request must
// never delay the app starting. The logo itself re-renders because the shells
// read the session on each render and this writes it back.
if (readSession()) {
  void refreshContext()
    .then(applyBranding)
    .catch(() => {
      // Offline, or the token expired and the api layer is already handling
      // it. Either way the cached branding stays, which is the right fallback.
    })
}

// Registered from the app itself so the PWA/native shell keeps working; the
// worker is served from the site root so its scope covers /app.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
