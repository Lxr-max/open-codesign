import type { ClickOptions, ElementHandle, Page } from 'puppeteer-core';

interface ZoomClickable extends ElementHandle<Element> {
  clickablePoint(offset?: { x: number; y: number }): Promise<{ x: number; y: number }>;
  scrollIntoViewIfNeeded(): Promise<void>;
}

interface IframeMetrics {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
}

/**
 * Puppeteer places an iframe click at the element's layout point plus the
 * iframe's visual origin. Preview zoom transforms the iframe, so those two
 * spaces differ and the click misses. Pointer events from a real cursor still
 * hit the scaled document; this only corrects the test driver.
 */
export async function installTransformedIframeClicks(page: Page): Promise<void> {
  const seed = await page.$('html');
  if (!seed) return;
  const proto = Object.getPrototypeOf(seed) as {
    click?: (this: ZoomClickable, options?: Readonly<ClickOptions>) => Promise<void>;
  };
  if (proto.click?.name === 'clickTransformedIframe') return;
  const original = proto.click;
  if (!original) return;

  proto.click = async function clickTransformedIframe(options) {
    const parent = this.frame.parentFrame();
    const iframe = parent ? await this.frame.frameElement() : null;
    const metrics = iframe ? await readIframeMetrics(iframe) : null;
    if (!metrics || !isScaled(metrics)) return original.call(this, options);

    await this.scrollIntoViewIfNeeded();
    const moved = iframe ? await readIframeMetrics(iframe) : null;
    const frame = moved && isScaled(moved) ? moved : metrics;
    const box = await this.clickablePoint(options?.offset);
    const scaleX = frame.width / frame.clientWidth;
    const scaleY = frame.height / frame.clientHeight;
    await this.frame
      .page()
      .mouse.click(
        frame.left + (box.x - frame.left) * scaleX,
        frame.top + (box.y - frame.top) * scaleY,
        {
          ...(options?.button !== undefined ? { button: options.button } : {}),
          ...(options?.count !== undefined ? { count: options.count } : {}),
          ...(options?.delay !== undefined ? { delay: options.delay } : {}),
        },
      );
  };
}

async function readIframeMetrics(iframe: ElementHandle<Element>): Promise<IframeMetrics | null> {
  return iframe.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
    };
  });
}

function isScaled(metrics: IframeMetrics): boolean {
  if (metrics.clientWidth <= 0 || metrics.clientHeight <= 0) return false;
  const scaleX = metrics.width / metrics.clientWidth;
  const scaleY = metrics.height / metrics.clientHeight;
  return Math.abs(scaleX - 1) >= 0.001 || Math.abs(scaleY - 1) >= 0.001;
}
