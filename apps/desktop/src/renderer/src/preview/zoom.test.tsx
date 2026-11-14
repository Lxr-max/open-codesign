// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodesignStore } from '../store';
import {
  previewScaledFrameStyle,
  previewZoomScale,
  useFitPreviewZoom,
  workspacePreviewOwnsFitZoom,
} from './zoom';

describe('previewScaledFrameStyle', () => {
  it('leaves the iframe layout matched to the pane at 100%', () => {
    expect(previewZoomScale(100)).toBe(1);
    expect(previewScaledFrameStyle(100)).toEqual({
      width: '100%',
      height: '100%',
      transform: 'scale(1)',
      transformOrigin: 'top left',
    });
  });

  it('doubles the layout viewport at 50% so a cropped desktop frame fits the pane', () => {
    expect(previewScaledFrameStyle(50)).toEqual({
      width: '200%',
      height: '200%',
      transform: 'scale(0.5)',
      transformOrigin: 'top left',
    });
  });

  it('halves the layout viewport at 200%', () => {
    expect(previewScaledFrameStyle(200)).toEqual({
      width: '50%',
      height: '50%',
      transform: 'scale(2)',
      transformOrigin: 'top left',
    });
  });

  it('ignores a non-positive zoom instead of inverting the frame', () => {
    expect(previewZoomScale(0)).toBe(1);
    expect(previewZoomScale(Number.NaN)).toBe(1);
    expect(previewScaledFrameStyle(-25).transform).toBe('scale(1)');
  });
});

describe('workspacePreviewOwnsFitZoom', () => {
  it('lets the visible file preview measure fit, including a file opened in a tab', () => {
    expect(workspacePreviewOwnsFitZoom('files')).toBe(true);
    expect(workspacePreviewOwnsFitZoom('file')).toBe(true);
    expect(workspacePreviewOwnsFitZoom(undefined)).toBe(false);
  });
});

function ZoomHarness({
  enabled,
  width,
  height,
}: {
  enabled: boolean;
  width: number;
  height: number;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useFitPreviewZoom(host, enabled);
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, 'clientWidth', { configurable: true, value: width });
          Object.defineProperty(node, 'clientHeight', { configurable: true, value: height });
        }
        setHost(node);
      }}
    />
  );
}

describe('useFitPreviewZoom', () => {
  let root: Root;
  let mount: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useCodesignStore.setState({
      previewZoom: 100,
      previewZoomMode: 'fit',
      previewViewport: 'desktop',
    });
    mount = document.createElement('div');
    document.body.appendChild(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mount.remove();
  });

  it('fits the reference desktop frame into the measured preview pane', () => {
    act(() => {
      root.render(<ZoomHarness enabled width={1000} height={800} />);
    });

    expect(useCodesignStore.getState().previewZoom).toBe(66);
    expect(useCodesignStore.getState().previewZoomMode).toBe('fit');
  });

  it('does not replace a manual percentage when the viewport changes', () => {
    act(() => {
      root.render(<ZoomHarness enabled width={1000} height={800} />);
    });
    act(() => {
      useCodesignStore.getState().setPreviewZoom(150);
      useCodesignStore.getState().setPreviewViewport('tablet');
    });

    expect(useCodesignStore.getState().previewZoom).toBe(150);
    expect(useCodesignStore.getState().previewZoomMode).toBe('manual');
  });

  it('leaves zoom alone while the file preview is not the measured surface', () => {
    useCodesignStore.setState({ previewZoom: 150, previewZoomMode: 'manual' });
    act(() => {
      root.render(<ZoomHarness enabled={false} width={1000} height={800} />);
    });

    expect(useCodesignStore.getState().previewZoom).toBe(150);
    expect(useCodesignStore.getState().previewZoomMode).toBe('manual');
  });

  it('does not reset fit when the preview host has not been laid out', () => {
    useCodesignStore.setState({ previewZoom: 66, previewZoomMode: 'fit' });
    act(() => {
      root.render(<ZoomHarness enabled width={0} height={0} />);
    });

    expect(useCodesignStore.getState().previewZoom).toBe(66);
    expect(useCodesignStore.getState().previewZoomMode).toBe('fit');
  });
});
