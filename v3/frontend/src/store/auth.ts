import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthUser {
  user_id: string
  email:   string
  name:    string
  avatar:  string
}

interface AuthStore {
  user:       AuthUser | null
  checked:    boolean          // true once /auth/me has been tried
  setUser:    (u: AuthUser | null) => void
  setChecked: (v: boolean) => void
  logout:     () => void
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user:       null,
      checked:    false,
      setUser:    (u) => set({ user: u, checked: true }),
      setChecked: (v) => set({ checked: v }),
      logout:     () => set({ user: null, checked: true }),
    }),
    {
      name:    'pa-auth-v2',
      partialize: (s) => ({ user: s.user }),
    }
  )
)

/** Fetch current user from server; returns null if not logged in. */
export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const r = await fetch('/api/v1/auth/me', { credentials: 'include' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function serverLogout(): Promise<void> {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' })
}
