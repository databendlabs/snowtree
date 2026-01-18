import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainLayout } from './components/layout';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useWorkspaceStageSync } from './hooks/useWorkspaceStageSync';
import { ErrorDialog } from './components/ErrorDialog';
import { useErrorStore } from './stores/errorStore';

export default function App() {
  useIPCEvents();
  useWorkspaceStageSync();
  const { currentError, clearError } = useErrorStore();
  const isIOS = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);
  const [isPortrait, setIsPortrait] = useState(false);
  const [portraitPane, setPortraitPane] = useState<'left' | 'right'>('left');
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const computePortraitMode = useCallback(() => {
    if (typeof window === 'undefined') return false;
    const isPortraitOrientation = window.matchMedia('(orientation: portrait)').matches
      || window.innerHeight > window.innerWidth;
    if (!isPortraitOrientation) return false;
    if (isIOS) return true;
    return window.innerWidth <= 980;
  }, [isIOS]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setIsPortrait(computePortraitMode());
    update();
    const media = window.matchMedia('(orientation: portrait)');
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [computePortraitMode]);

  useEffect(() => {
    if (!isPortrait) {
      setPortraitPane('left');
    }
  }, [isPortrait]);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!isPortrait) return;
    if (event.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, [isPortrait]);

  const handleTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!isPortrait) return;
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx < 0) setPortraitPane('right');
    else setPortraitPane('left');
  }, [isPortrait]);

  const showSidebar = !isPortrait || portraitPane === 'left';
  const showRightPanel = !isPortrait || portraitPane === 'right';

  return (
    <div
      className="h-screen w-screen flex overflow-hidden relative"
      style={{
        paddingTop: 'calc(var(--st-titlebar-gap) + env(safe-area-inset-top, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        height: '100dvh',
        minHeight: '100dvh',
        backgroundColor: 'var(--st-bg)',
        color: 'var(--st-text)',
        touchAction: isPortrait ? 'pan-y' : 'auto',
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Drag region for macOS hiddenInset titlebar */}
      <div
        className="absolute top-0 left-0 right-0 z-50"
        style={{
          height: 'var(--st-titlebar-gap)',
          // @ts-expect-error - webkit vendor prefix
          WebkitAppRegion: 'drag',
        }}
      />
      <Sidebar isHidden={!showSidebar} />
      <MainLayout hideRightPanel={!showRightPanel} />

      {currentError && (
        <ErrorDialog
          isOpen={true}
          onClose={clearError}
          title={currentError.title}
          error={currentError.error}
          details={currentError.details}
          command={currentError.command}
        />
      )}
    </div>
  );
}
