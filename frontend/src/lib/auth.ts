import { api } from './api'

export interface User {
  id: number
  email: string
  display_name: string | null
  language: string
  is_superadmin: boolean
  roles: string[]
  permissions: string[]
}

export interface LoginCredentials {
  email: string
  password: string
}

export interface LoginResponse {
  user_id: number
  email: string
  display_name: string | null
  language: string
}

let currentUser: User | null = null
let currentUserPromise: Promise<User | null> | null = null

export async function login(credentials: LoginCredentials): Promise<LoginResponse> {
  const response = await api.post<LoginResponse>('/auth/login', credentials)
  currentUser = null
  return response
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } finally {
    currentUser = null
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
  }
}

export async function getMe(): Promise<User | null> {
  if (currentUser) return currentUser

  if (currentUserPromise) return currentUserPromise

  currentUserPromise = api.get<User>('/auth/me')
    .then(user => {
      currentUser = user
      return user
    })
    .catch(() => {
      currentUser = null
      return null
    })
    .finally(() => {
      currentUserPromise = null
    })

  return currentUserPromise
}

export async function requireAuth(): Promise<User> {
  const user = await getMe()
  if (!user) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }
  return user
}

export function hasPermission(user: User, permission: string): boolean {
  if (user.is_superadmin) return true
  return user.permissions.includes(permission)
}

export function hasAnyPermission(user: User, permissions: string[]): boolean {
  if (user.is_superadmin) return true
  return permissions.some(p => user.permissions.includes(p))
}

export function hasRole(user: User, role: string): boolean {
  return user.roles.includes(role)
}

export function clearUser(): void {
  currentUser = null
}
