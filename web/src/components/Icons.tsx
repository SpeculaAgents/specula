// Drawn icons. No emoji and no symbol characters anywhere on the site.
const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "square" as const, viewBox: "0 0 24 24", "aria-hidden": true };
export const ArrowRight = () => (<svg {...base}><path d="M4 12h15M13 6l6 6-6 6" /></svg>);
export const ArrowUpRight = () => (<svg {...base}><path d="M7 17 17 7M8 7h9v9" /></svg>);
export const Menu = () => (<svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /></svg>);
export const Close = () => (<svg {...base}><path d="m6 6 12 12M18 6 6 18" /></svg>);
export const Check = () => (<svg {...base}><path d="m5 12 5 5 9-10" /></svg>);
export const Play = () => (<svg {...base}><path d="M7 5v14l12-7z" fill="currentColor" /></svg>);
export const Copy = () => (<svg {...base}><path d="M9 9h10v10H9zM5 15V5h10" /></svg>);
export const GitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
  </svg>
);
export const XLogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.2h1.7L7.4 4.7H5.57l11.1 14.5Z" />
  </svg>
);
