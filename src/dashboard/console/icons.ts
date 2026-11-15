import { svg, type SVGTemplateResult } from 'lit';

/**
 * The console's icons: sixteen-unit line drawings in the ink of whatever
 * holds them (`currentColor`), so none brings a colour of its own.
 */
const icon = (body: SVGTemplateResult): SVGTemplateResult => svg`
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  /** The dashboard: rings, as the engines are drawn on the field. */
  dashboard: () => icon(svg`<circle cx="5.2" cy="5.6" r="3"/><circle cx="11.6" cy="10.6" r="2.2"/><path d="M9.4 3.4h4.2M2.4 11h4.4M2.4 13.4h3"/>`),
  /** The fleet: machines side by side. */
  fleet: () => icon(svg`<rect x="1.6" y="3" width="5.4" height="4.2" rx="1"/><rect x="9" y="3" width="5.4" height="4.2" rx="1"/><rect x="5.3" y="9.6" width="5.4" height="4.2" rx="1"/><path d="M3.2 5.1h.01M10.6 5.1h.01M6.9 11.7h.01"/>`),
  /** Repositories: a branch. */
  repositories: () => icon(svg`<circle cx="4.4" cy="3.6" r="1.6"/><circle cx="4.4" cy="12.4" r="1.6"/><circle cx="11.6" cy="5.4" r="1.6"/><path d="M4.4 5.2v5.6M11.6 7c0 2.6-3.2 2.4-7.2 3.8"/>`),
  chevronLeft: () => icon(svg`<path d="M9.8 3.6 5.4 8l4.4 4.4"/>`),
  chevronRight: () => icon(svg`<path d="M6.2 3.6 10.6 8l-4.4 4.4"/>`),
  signOut: () => icon(svg`<path d="M6.4 2.6H3.6a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h2.8M10.2 5.2 13 8l-2.8 2.8M13 8H6.4"/>`),
  copy: () => icon(svg`<rect x="5.4" y="5.4" width="8" height="8" rx="1.2"/><path d="M10.6 5.4V3.6a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.8"/>`),
  /** The mark: a hull, with the work on its deck. */
  mark: () => svg`
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.4 14.2h19.2l-2.4 4.8a1.6 1.6 0 0 1-1.4.9H6.2a1.6 1.6 0 0 1-1.4-.9l-2.4-4.8Z"/>
      <rect x="5.2" y="9.6" width="3.8" height="3.6" rx=".6" opacity=".55"/>
      <rect x="10.1" y="9.6" width="3.8" height="3.6" rx=".6" opacity=".8"/>
      <rect x="15" y="9.6" width="3.8" height="3.6" rx=".6" opacity=".55"/>
      <rect x="7.6" y="5.2" width="3.8" height="3.6" rx=".6" opacity=".8"/>
      <rect x="12.6" y="5.2" width="3.8" height="3.6" rx=".6" opacity=".55"/>
    </svg>`,
};
