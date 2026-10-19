/** Inline SVG icons built with createElementNS (no innerHTML). All decorative. */

const NS = 'http://www.w3.org/2000/svg';

type IconName = 'close' | 'send' | 'book' | 'link';

const ICONS: Record<IconName, { paths: string[]; width: string; fill?: boolean }> = {
  close: { paths: ['M6 6l12 12M18 6L6 18'], width: '2.6' },
  send: { paths: ['M12 19V5M6 11l6-6 6 6'], width: '2.2' },
  book: {
    paths: ['M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z', 'M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z'],
    width: '2',
  },
  link: {
    paths: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    width: '2',
  },
};

export function icon(doc: Document, name: IconName, className = 'poe-icon'): SVGSVGElement {
  const def = ICONS[name];
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', def.width);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of def.paths) {
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg as SVGSVGElement;
}
