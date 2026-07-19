import { useState, useEffect, useCallback } from 'react';
import type { PipelineMode } from './types';

// Shared mode state kept in-memory (no browser storage). Defaults to demo mode so the
// app works with no API key. A module-level value keeps the choice consistent across
// pages within a session without persisting anything.
let currentMode: PipelineMode = 'demo';
const listeners = new Set<(m: PipelineMode) => void>();

export function useMode() {
  const [mode, setLocal] = useState<PipelineMode>(currentMode);

  useEffect(() => {
    const l = (m: PipelineMode) => setLocal(m);
    listeners.add(l);
    setLocal(currentMode);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const setMode = useCallback((m: PipelineMode) => {
    currentMode = m;
    listeners.forEach((l) => l(m));
  }, []);

  return { mode, setMode };
}
