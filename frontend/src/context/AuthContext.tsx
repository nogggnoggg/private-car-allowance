import type React from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiGetMe, apiLogout } from "../api/auth.js";
import type { UserDto } from "../types/api.js";

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: UserDto };

interface AuthContextValue {
  authState: AuthState;
  /** Refresh user info from /api/me */
  refreshAuth: () => Promise<void>;
  /** Call after successful login to set user directly */
  setUser: (user: UserDto) => void;
  /** Logout and clear state */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState>({ status: "loading" });

  const refreshAuth = useCallback(async () => {
    try {
      const { user } = await apiGetMe();
      setAuthState({ status: "authenticated", user });
    } catch {
      setAuthState({ status: "unauthenticated" });
    }
  }, []);

  const setUser = useCallback((user: UserDto) => {
    setAuthState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // ignore errors on logout
    }
    setAuthState({ status: "unauthenticated" });
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  return (
    <AuthContext.Provider value={{ authState, refreshAuth, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
