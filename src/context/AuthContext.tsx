'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

export interface UserProfile {
  id: string;
  organisation_id: string;
  first_name: string;
  last_name: string;
  employee_number?: string;
  phone_number?: string;
  is_active: boolean;
}

export interface UserRoleRecord {
  role: 'super_admin' | 'admin' | 'supervisor' | 'guard' | 'client_viewer';
}

export interface AssignedSite {
  id: string;
  name: string;
  code: string;
  organisation_id: string;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  profile: UserProfile | null;
  roles: string[];
  assignedSite: AssignedSite | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  profile: null,
  roles: [],
  assignedSite: null,
  isLoading: true,
  signOut: async () => {},
  refreshProfile: async () => {}
});

const CACHED_AUTH_KEY = 'eagle_eye_cached_auth_v1';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(CACHED_AUTH_KEY);
        if (cached) return JSON.parse(cached).profile || null;
      } catch {
        // Ignore
      }
    }
    return null;
  });
  const [roles, setRoles] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(CACHED_AUTH_KEY);
        if (cached) return JSON.parse(cached).roles || [];
      } catch {
        // Ignore
      }
    }
    return [];
  });
  const [assignedSite, setAssignedSite] = useState<AssignedSite | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(CACHED_AUTH_KEY);
        if (cached) return JSON.parse(cached).assignedSite || null;
      } catch {
        // Ignore
      }
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(true);

  const supabase = useMemo(() => createClient(), []);

  const loadUserData = useCallback(async (currentUser: User) => {
    try {
      // 1. Load Profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .maybeSingle();

      if (profileData) {
        setProfile(profileData as UserProfile);
      }

      // 2. Load Roles
      const { data: rolesData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', currentUser.id);

      const userRoles = (rolesData || []).map((r) => r.role);
      setRoles(userRoles);

      // 3. Load Assigned Site
      const { data: assignmentData } = await supabase
        .from('site_assignments')
        .select('site_id, sites(id, name, code, organisation_id)')
        .eq('user_id', currentUser.id)
        .limit(1)
        .maybeSingle();

      let siteObj: AssignedSite | null = null;
      if (assignmentData && assignmentData.sites) {
        const s = assignmentData.sites as unknown as AssignedSite;
        siteObj = {
          id: s.id,
          name: s.name,
          code: s.code,
          organisation_id: s.organisation_id
        };
        setAssignedSite(siteObj);
      } else {
        // Fallback: If admin/supervisor, fetch first site in organisation
        if (userRoles.some((r) => ['admin', 'super_admin', 'supervisor'].includes(r)) && profileData?.organisation_id) {
          const { data: firstSite } = await supabase
            .from('sites')
            .select('id, name, code, organisation_id')
            .eq('organisation_id', profileData.organisation_id)
            .limit(1)
            .maybeSingle();

          if (firstSite) {
            siteObj = firstSite as AssignedSite;
            setAssignedSite(siteObj);
          }
        }
      }

      // Cache for offline mobile guard usage
      if (typeof window !== 'undefined' && profileData) {
        localStorage.setItem(
          CACHED_AUTH_KEY,
          JSON.stringify({
            profile: profileData,
            roles: userRoles,
            assignedSite: siteObj
          })
        );
      }
    } catch (err) {
      console.warn('Could not load user data from Supabase (offline mode):', err);
    }
  }, [supabase]);

  useEffect(() => {
    let isMounted = true;

    // Check active session
    supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
      if (!isMounted) return;
      setSession(currentSession);
      setUser(currentSession?.user ?? null);

      if (currentSession?.user) {
        loadUserData(currentSession.user).finally(() => {
          if (isMounted) setIsLoading(false);
        });
      } else {
        setIsLoading(false);
      }
    });

    // Listen for auth changes
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!isMounted) return;
      setSession(newSession);
      setUser(newSession?.user ?? null);

      if (newSession?.user) {
        await loadUserData(newSession.user);
      } else {
        setProfile(null);
        setRoles([]);
        setAssignedSite(null);
        if (typeof window !== 'undefined') {
          localStorage.removeItem(CACHED_AUTH_KEY);
        }
      }
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase, loadUserData]);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore network errors during sign out
    }
    setUser(null);
    setSession(null);
    setProfile(null);
    setRoles([]);
    setAssignedSite(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(CACHED_AUTH_KEY);
    }
  };

  const refreshProfile = async () => {
    if (user) {
      await loadUserData(user);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        roles,
        assignedSite,
        isLoading,
        signOut,
        refreshProfile
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
