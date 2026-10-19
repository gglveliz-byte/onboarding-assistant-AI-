/**
 * @archivo apps/web/src/components/auth-legal/useAuthSessionContext.tsx
 * @modulo apps/web (Contexto de Sesión en Memoria RAM)
 * @proposito
 *   Provee a todo el portal de autenticación y a los paneles el estado de sesión del usuario:
 *   token de acceso SOLO en memoria (useState/useRef; jamás localStorage, sessionStorage ni
 *   cookies), perfil con rol y permisos, fase de sesión, reto MFA pendiente y bloqueo temporal
 *   de cuenta. Rota el token de forma silenciosa 60 segundos antes de su vencimiento contra
 *   `POST /api/v1/auth/refresh` (la cookie de refresco viaja con `credentials: 'include'`,
 *   sin cuerpo) y expira la sesión de forma ordenada ante cualquier fallo, notificando al
 *   consumidor mediante `onSessionExpired`.
 *
 * @resumen_contenido
 *   - `AuthSessionContextValue`: contrato del contexto que consumen los subagentes 2.3 y 2.4.
 *   - `AuthSessionProvider`: estado en RAM, rotación silenciosa, expiración y cierre de sesión.
 *   - `useAuthSession()`: hook de acceso; lanza `Error` si falta el provider.
 *   - Internos: guardas de forma de la respuesta de renovación y utilidades de limpieza.
 *
 * @dependencias_internas
 *   - `authApiFetch`, `buildSessionProfile`, `readTokenExpiryEpochMs` y los tipos del cliente
 *     único del área auth (`./auth-api-client`).
 *
 * @dependencias_externas
 *   - `react` (`createContext`, hooks y tipos `ReactElement`/`ReactNode`). Sin `next/*`.
 *
 * @notas
 *   - `logout()` y `logoutAll()` comparten endpoint: `revokeSessionsUseCase` del backend
 *     revoca TODAS las sesiones del usuario en `POST /api/v1/auth/logout`; la limpieza local
 *     se ejecuta SIEMPRE, aunque la llamada de red falle (try/finally).
 *   - La respuesta real de renovación `{ accessToken, user, organization }` NO incluye
 *     `role`, por lo que se conserva el rol y el perfil anteriores de la sesión en memoria.
 */

'use client';

import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSessionUserProfile, BackendPublicOrganization, BackendPublicUser } from './auth-api-client';
import { authApiFetch, buildSessionProfile, readTokenExpiryEpochMs } from './auth-api-client';
import { setAccessToken as setGlobalAccessToken } from '../../lib/api-client/http-client';
import { setSessionOrgSlug } from '../../lib/api-client/http-client';
import { clearProjectsCache } from '../dashboard-dev/useProjectsAndApiKeys';

/**
 * Contrato del contexto de sesión: estado inmutable expuesto y las nueve operaciones que el
 * área de autenticación (login, MFA, recuperación, wizard de registro) necesita.
 */
export interface AuthSessionContextValue {
  readonly accessToken: string | null;
  readonly user: AuthSessionUserProfile | null;
  readonly isAuthenticated: boolean;
  readonly sessionPhase: 'anonymous' | 'authenticated' | 'expired';
  readonly mfaChallengeToken: string | null;
  readonly lockedUntilEpochMs: number | null;
  beginMfaChallenge(token: string): void;
  cancelMfaChallenge(): void;
  completeAuthentication(accessToken: string, user: AuthSessionUserProfile): void;
  hasPermission(permissionCode: string): boolean;
  refreshAccessToken(): Promise<boolean>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  markLocked(lockedUntilEpochMs: number | null): void;
}

/** Cuerpo real de `POST /api/v1/auth/refresh` (sin `role`: se conserva el perfil anterior). */
interface RefreshSessionResponseBody {
  readonly accessToken?: string;
  readonly user?: unknown;
  readonly organization?: unknown;
}

/** Margen de rotación silenciosa: 60 s antes del vencimiento del token de acceso. */
const SILENT_REFRESH_LEAD_MS = 60_000;

/** Contexto con valor nulo por defecto: el hook lanza si falta el provider (nunca falso error). */
const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

/** Determina si un valor desconocido es un registro JSON indexable (ni arreglo ni `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida la forma mínima de la proyección pública de usuario de la respuesta de renovación. */
function isBackendPublicUser(value: unknown): value is BackendPublicUser {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value['id'] === 'string'
    && typeof value['email'] === 'string'
    && typeof value['fullName'] === 'string';
}

/** Coerciona la organización de la respuesta de renovación; `null` si no es utilizable. */
function coerceOrganization(value: unknown): BackendPublicOrganization | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const name = value['name'];
  const slug = value['slug'];
  if (typeof id !== 'string' || typeof name !== 'string' || typeof slug !== 'string') {
    return null;
  }
  const status = value['status'];
  return { id, name, slug, status: typeof status === 'string' ? status : '' };
}

/**
 * Proveedor del contexto de sesión en memoria RAM.
 *
 * @param props - Hijos del árbol y callback opcional disparado al expirar la sesión.
 * @returns Árbol envuelto por el contexto de sesión.
 */
export function AuthSessionProvider(props: {
  readonly children: ReactNode;
  readonly onSessionExpired?: () => void;
}): ReactElement {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthSessionUserProfile | null>(null);
  const [sessionPhase, setSessionPhase] = useState<'anonymous' | 'authenticated' | 'expired'>('anonymous');
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [lockedUntilEpochMs, setLockedUntilEpochMs] = useState<number | null>(null);

  const accessTokenRef = useRef<string | null>(null);
  const userRef = useRef<AuthSessionUserProfile | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshRunnerRef = useRef<(() => void) | null>(null);
  const onSessionExpiredRef = useRef<(() => void) | null>(null);

  useEffect((): void => {
    onSessionExpiredRef.current = props.onSessionExpired ?? null;
  }, [props.onSessionExpired]);

  /** Cancela el temporizador de rotación silenciosa pendiente (si existe). */
  const clearRefreshTimer = useCallback((): void => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  /** Programa la rotación silenciosa 60 s antes del vencimiento del token (si es legible). */
  const scheduleSilentRefresh = useCallback((token: string): void => {
    clearRefreshTimer();
    const expiryEpochMs = readTokenExpiryEpochMs(token);
    if (expiryEpochMs === null) {
      return;
    }
    const delayMs = Math.max(expiryEpochMs - Date.now() - SILENT_REFRESH_LEAD_MS, 0);
    refreshTimerRef.current = window.setTimeout((): void => {
      refreshRunnerRef.current?.();
    }, delayMs);
  }, [clearRefreshTimer]);

  /** Limpia el estado de sesión y lo deja en la fase indicada (sin llamadas de red). */
  const clearSessionState = useCallback((nextPhase: 'anonymous' | 'expired'): void => {
    clearRefreshTimer();
    setGlobalAccessToken(null);
    setSessionOrgSlug(null);
    clearProjectsCache();
    accessTokenRef.current = null;
    userRef.current = null;
    setAccessToken(null);
    setUser(null);
    setMfaChallengeToken(null);
    setLockedUntilEpochMs(null);
    setSessionPhase(nextPhase);
  }, [clearRefreshTimer]);

  /** Re-autentica la sesión: fija token y perfil, limpia retos y programa la rotación. */
  const applyAuthenticatedSession = useCallback((nextToken: string, nextProfile: AuthSessionUserProfile): void => {
    setGlobalAccessToken(nextToken);
    setSessionOrgSlug(nextProfile.orgSlug.length > 0 ? nextProfile.orgSlug : null);
    accessTokenRef.current = nextToken;
    userRef.current = nextProfile;
    setAccessToken(nextToken);
    setUser(nextProfile);
    setMfaChallengeToken(null);
    setLockedUntilEpochMs(null);
    setSessionPhase('authenticated');
    scheduleSilentRefresh(nextToken);
  }, [scheduleSilentRefresh]);

  /** Expira la sesión: limpia estado y notifica al consumidor mediante `onSessionExpired`. */
  const expireLocalSession = useCallback((): void => {
    clearSessionState('expired');
    const notifyExpired = onSessionExpiredRef.current;
    if (notifyExpired !== null) {
      notifyExpired();
    }
  }, [clearSessionState]);

  /**
   * Rota el token contra `POST /api/v1/auth/refresh` conservando el rol y el perfil previos
   * (la respuesta real no trae `role`). Si el token no llega o el servidor falla, expira la
   * sesión de forma ordenada y devuelve `false`.
   */
  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    const response = await authApiFetch<RefreshSessionResponseBody>('/api/v1/auth/refresh', {
      method: 'POST',
      credentialsMode: 'include',
    });
    const refreshedToken = response.data?.accessToken;
    if (!response.ok || typeof refreshedToken !== 'string' || refreshedToken.length === 0) {
      expireLocalSession();
      return false;
    }
    const refreshedUser = response.data?.user;
    const previousProfile = userRef.current;
    let nextProfile = previousProfile;
    if (previousProfile !== null && isBackendPublicUser(refreshedUser)) {
      nextProfile = buildSessionProfile({
        user: refreshedUser,
        organization: coerceOrganization(response.data?.organization),
        role: previousProfile.role,
        mfaSatisfied: previousProfile.mfaSatisfied,
      });
    }
    if (nextProfile === null) {
      expireLocalSession();
      return false;
    }
    applyAuthenticatedSession(refreshedToken, nextProfile);
    return true;
  }, [applyAuthenticatedSession, expireLocalSession]);

  useEffect((): void => {
    refreshRunnerRef.current = (): void => {
      void refreshAccessToken();
    };
  }, [refreshAccessToken]);

  useEffect((): (() => void) => {
    return (): void => {
      clearRefreshTimer();
    };
  }, [clearRefreshTimer]);

  /** Re-autentica tras un login o registro exitoso (contrato público del contexto). */
  const completeAuthentication = useCallback((nextAccessToken: string, nextUser: AuthSessionUserProfile): void => {
    applyAuthenticatedSession(nextAccessToken, nextUser);
  }, [applyAuthenticatedSession]);

  /** Guarda el token de reto MFA emitido por el login para los subagentes 2.3/2.4. */
  const beginMfaChallenge = useCallback((token: string): void => {
    setMfaChallengeToken(token);
  }, []);

  /** Descarta el reto MFA pendiente (cancelación explícita del usuario). */
  const cancelMfaChallenge = useCallback((): void => {
    setMfaChallengeToken(null);
  }, []);

  /** Registra o limpia el bloqueo temporal de cuenta reportado por el servidor. */
  const markLocked = useCallback((nextLockedUntilEpochMs: number | null): void => {
    setLockedUntilEpochMs(nextLockedUntilEpochMs);
  }, []);

  /** Gating de UI por permiso: consulta el espejo de permisos del rol (autoridad: servidor). */
  const hasPermission = useCallback((permissionCode: string): boolean => {
    return user !== null && user.permissions.includes(permissionCode);
  }, [user]);

  /** Revoca en el servidor las sesiones del usuario y limpia SIEMPRE el estado local. */
  const revokeSessionsAndClearLocalState = useCallback(async (): Promise<void> => {
    const currentToken = accessTokenRef.current;
    try {
      await authApiFetch<{ readonly revoked: boolean }>('/api/v1/auth/logout', {
        method: 'POST',
        ...(currentToken === null ? {} : { accessToken: currentToken }),
      });
    } finally {
      clearSessionState('anonymous');
    }
  }, [clearSessionState]);

  /** Cierra la sesión actual revocando las sesiones del usuario en el servidor. */
  const logout = useCallback(async (): Promise<void> => {
    await revokeSessionsAndClearLocalState();
  }, [revokeSessionsAndClearLocalState]);

  /** Alias con el mismo endpoint real: `revokeSessionsUseCase` revoca TODAS las sesiones. */
  const logoutAll = useCallback(async (): Promise<void> => {
    await revokeSessionsAndClearLocalState();
  }, [revokeSessionsAndClearLocalState]);

  const contextValue = useMemo<AuthSessionContextValue>(() => ({
    accessToken,
    user,
    isAuthenticated: sessionPhase === 'authenticated' && accessToken !== null && user !== null,
    sessionPhase,
    mfaChallengeToken,
    lockedUntilEpochMs,
    beginMfaChallenge,
    cancelMfaChallenge,
    completeAuthentication,
    hasPermission,
    refreshAccessToken,
    logout,
    logoutAll,
    markLocked,
  }), [
    accessToken, user, sessionPhase, mfaChallengeToken, lockedUntilEpochMs,
    beginMfaChallenge, cancelMfaChallenge, completeAuthentication, hasPermission,
    refreshAccessToken, logout, logoutAll, markLocked,
  ]);

  return (
    <AuthSessionContext.Provider value={contextValue}>{props.children}</AuthSessionContext.Provider>
  );
}

/**
 * Acceso al contexto de sesión compartido por las vistas del área de autenticación y paneles.
 *
 * @returns Valor del contexto con estado y operaciones de sesión.
 * @throws Error cuando se invoca fuera de `<AuthSessionProvider>` (configuración incorrecta).
 */
export function useAuthSession(): AuthSessionContextValue {
  const contextValue = useContext(AuthSessionContext);
  if (contextValue === null) {
    throw new Error('useAuthSession debe invocarse dentro de <AuthSessionProvider>; envuelve la vista en el proveedor de sesión.');
  }
  return contextValue;
}
