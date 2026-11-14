import type { CSSProperties } from 'react';
import { useLayoutEffect } from 'react';
import { type PreviewViewport, useCodesignStore } from '../store';

const PREVIEW_FRAME_PADDING_PX = 48;
const PREVIEW_DIMENSIONS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 381, height: 818 },
} as const satisfies Record<PreviewViewport, { width: number; height: number }>;

export function previewViewportDimensions(viewport: PreviewViewport): {
  width: number;
  height: number;
} {
  return PREVIEW_DIMENSIONS[viewport];
}

export function computeFitPreviewZoom(input: {
  containerWidth: number;
  containerHeight: number;
  viewport: PreviewViewport;
}): number {
  if (input.containerWidth <= 0 || input.containerHeight <= 0) return 100;
  const frame = previewViewportDimensions(input.viewport);
  const availableWidth = Math.max(1, input.containerWidth - PREVIEW_FRAME_PADDING_PX);
  const availableHeight = Math.max(1, input.containerHeight - PREVIEW_FRAME_PADDING_PX);
  const fit = Math.min(availableWidth / frame.width, availableHeight / frame.height) * 100;
  return Math.min(100, Math.max(25, Math.floor(fit)));
}

export function workspacePreviewOwnsFitZoom(kind: string | undefined): boolean {
  return kind === 'files' || kind === 'file';
}

export function previewZoomScale(zoomPercent: number): number {
  if (!Number.isFinite(zoomPercent) || zoomPercent <= 0) return 1;
  return zoomPercent / 100;
}

/**
 * Zoom has to change the iframe's layout viewport and then scale that viewport
 * back into the pane. The toolbar used to store a percentage the workspace
 * iframe never read, so fit and percentage selections left the design at the
 * pane's CSS size.
 */
export function previewScaledFrameStyle(zoomPercent: number): CSSProperties {
  const scale = previewZoomScale(zoomPercent);
  // Lay the iframe out larger or smaller than the pane, then transform it back
  // so the painted design matches the selected zoom. The layout box stays on
  // clientWidth; comment anchors already divide the visual frame by that.
  return {
    width: `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
  };
}

export function useFitPreviewZoom(host: HTMLElement | null, enabled: boolean): void {
  const previewZoomMode = useCodesignStore((s) => s.previewZoomMode);
  const previewViewport = useCodesignStore((s) => s.previewViewport);
  const setPreviewZoomFit = useCodesignStore((s) => s.setPreviewZoomFit);

  useLayoutEffect(() => {
    if (!enabled || previewZoomMode !== 'fit' || host === null) return;
    let scheduled: { kind: 'raf' | 'timeout'; id: number } | null = null;

    const updateFitZoom = () => {
      const state = useCodesignStore.getState();
      // A resize can be delivered after a manual percentage is chosen and
      // before this effect tears down. Fit must not put that choice back.
      if (state.previewZoomMode !== 'fit') return;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      const next = computeFitPreviewZoom({
        containerWidth: host.clientWidth,
        containerHeight: host.clientHeight,
        viewport: previewViewport,
      });
      if (state.previewZoom !== next) setPreviewZoomFit(next);
    };
    const scheduleFitZoom = () => {
      if (scheduled !== null) return;
      const flush = () => {
        scheduled = null;
        updateFitZoom();
      };
      if (typeof window.requestAnimationFrame === 'function') {
        scheduled = { kind: 'raf', id: window.requestAnimationFrame(flush) };
      } else {
        scheduled = { kind: 'timeout', id: window.setTimeout(flush, 0) };
      }
    };
    const cancelScheduledFitZoom = () => {
      if (scheduled === null) return;
      if (scheduled.kind === 'raf') window.cancelAnimationFrame(scheduled.id);
      else window.clearTimeout(scheduled.id);
      scheduled = null;
    };

    updateFitZoom();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateFitZoom);
      return () => window.removeEventListener('resize', updateFitZoom);
    }
    const observer = new ResizeObserver(scheduleFitZoom);
    observer.observe(host);
    return () => {
      observer.disconnect();
      cancelScheduledFitZoom();
    };
  }, [enabled, host, previewViewport, previewZoomMode, setPreviewZoomFit]);
}
