import { useCallback, useEffect, useRef, useState } from 'react';
import { initialState } from '@/data';
import type { BrowserState } from '@/types';

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'offline' | 'error';

export function useBrowserState() {
  const [state, setState] = useState<BrowserState>(initialState);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [integrity, setIntegrity] = useState({
    verified: true,
    sequence: 0,
    head: '',
  });
  const hydrated = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/browser/state')
      .then(async (response) => {
        if (!response.ok) throw new Error('State service unavailable');
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        if (payload.state) setState(payload.state);
        setIntegrity(payload.integrity);
        setStatus('saved');
        hydrated.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('offline');
        hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateState = useCallback(
    (updater: (current: BrowserState) => BrowserState) => {
      setState((current) => {
        const next = {
          ...updater(current),
          updatedAt: new Date().toISOString(),
        };
        if (!hydrated.current) return next;
        setStatus('saving');
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          fetch('/api/browser/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          })
            .then(async (response) => {
              if (!response.ok) throw new Error('Save failed');
              return response.json();
            })
            .then((payload) => {
              setIntegrity(payload.integrity);
              setStatus('saved');
            })
            .catch(() => setStatus('error'));
        }, 350);
        return next;
      });
    },
    [],
  );

  return { state, updateState, status, integrity };
}