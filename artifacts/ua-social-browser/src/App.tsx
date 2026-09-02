import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { BrowserChrome } from '@/components/app/browser-chrome';
import { SideNav } from '@/components/app/side-nav';
import { useBrowserState } from '@/hooks/use-browser-state';
import { useScheduledDispatches } from '@/hooks/use-scheduler';
import { Dashboard } from '@/sections/dashboard';
import { Network } from '@/sections/network';
import { Composer } from '@/sections/composer';
import { Drafts } from '@/sections/drafts';
import { Calendar } from '@/sections/calendar';
import { Accounts } from '@/sections/accounts';
import { ProfilesSection } from '@/sections/profiles';
import { Usage } from '@/sections/usage';
import { Settings } from '@/sections/settings';
import {
  activeWorkspace,
  createId,
  logActivity,
  profileForWorkspace,
} from '@/lib/workspace';
import { platformProfile } from '@/lib/platforms';
import type { Section } from '@/types';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
  },
});

function Workbench() {
  const { state, updateState, status, integrity } = useBrowserState();
  const [section, setSection] = useState<Section>('dashboard');

  // Scheduled posts are dispatched by the API server, including while this
  // page is closed. Pick up whatever happened, whichever section is open.
  useScheduledDispatches(state, updateState);

  const workspace = activeWorkspace(state);
  const profile = profileForWorkspace(state, workspace);

  const counts = useMemo(() => {
    if (!workspace) return { drafts: 0, scheduled: 0 };
    const mine = state.drafts.filter(
      (draft) => draft.workspaceId === workspace.id,
    );
    return {
      drafts: mine.filter(
        (draft) => draft.status === 'draft' || draft.status === 'approved',
      ).length,
      scheduled: mine.filter((draft) => draft.status === 'scheduled').length,
    };
  }, [state.drafts, workspace]);

  function selectWorkspace(workspaceId: string) {
    updateState((current) => ({ ...current, activeWorkspaceId: workspaceId }));
  }

  function closeWorkspace(workspaceId: string) {
    updateState((current) => {
      if (current.workspaces.length <= 1) return current;
      const remaining = current.workspaces.filter(
        (item) => item.id !== workspaceId,
      );
      return {
        ...current,
        workspaces: remaining,
        activeWorkspaceId:
          current.activeWorkspaceId === workspaceId
            ? (remaining[0]?.id ?? '')
            : current.activeWorkspaceId,
      };
    });
  }

  function newWorkspace() {
    updateState((current) => {
      const id = createId('ws');
      const fallbackProfile = current.uaProfiles[0];
      const index = current.workspaces.length + 1;
      return {
        ...current,
        activeWorkspaceId: id,
        workspaces: [
          ...current.workspaces,
          {
            id,
            name: `Workspace ${index}`,
            profileId: fallbackProfile?.id ?? '',
            platform: 'x',
            accountHandle: '',
            status: 'ready',
            accent: platformProfile('x').accent,
            lastActive: 'Now',
          },
        ],
        activity: logActivity(current, {
          type: 'workspace',
          title: 'Workspace created',
          detail: `Isolated context with its own cookie jar · Workspace ${index}`,
        }),
      };
    });
    setSection('profiles');
  }

  if (!workspace) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-lg font-semibold">No workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Every workspace is an isolated browsing identity. Create one to
            start.
          </p>
          <button
            type="button"
            onClick={newWorkspace}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover-elevate"
            data-testid="button-create-first-workspace"
          >
            Create a workspace
          </button>
        </div>
      </div>
    );
  }

  const sectionProps = {
    state,
    updateState,
    workspace,
    profile,
    onNavigate: setSection,
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BrowserChrome
        workspaces={state.workspaces}
        activeWorkspaceId={workspace.id}
        activeProfile={profile}
        saveStatus={status}
        integrityVerified={integrity.verified}
        onSelectWorkspace={selectWorkspace}
        onCloseWorkspace={closeWorkspace}
        onNewWorkspace={newWorkspace}
      />

      <div className="flex min-h-0 flex-1">
        <SideNav
          section={section}
          onSelect={setSection}
          draftCount={counts.drafts}
          scheduledCount={counts.scheduled}
          accent={workspace.accent}
        />

        <main className="min-w-0 flex-1 overflow-y-auto">
          {section === 'dashboard' ? <Dashboard {...sectionProps} /> : null}
          {section === 'network' ? <Network {...sectionProps} /> : null}
          {section === 'composer' ? <Composer {...sectionProps} /> : null}
          {section === 'drafts' ? <Drafts {...sectionProps} /> : null}
          {section === 'calendar' ? <Calendar {...sectionProps} /> : null}
          {section === 'accounts' ? <Accounts {...sectionProps} /> : null}
          {section === 'profiles' ? <ProfilesSection {...sectionProps} /> : null}
          {section === 'usage' ? <Usage {...sectionProps} /> : null}
          {section === 'settings' ? (
            <Settings {...sectionProps} integrity={integrity} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  // The shell is a dark desktop surface; there is no light-mode toggle yet.
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <Workbench />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
