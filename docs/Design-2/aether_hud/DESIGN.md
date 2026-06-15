---
name: Aether HUD
colors:
  surface: '#111417'
  surface-dim: '#111417'
  surface-bright: '#37393d'
  surface-container-lowest: '#0c0e12'
  surface-container-low: '#191c1f'
  surface-container: '#1d2023'
  surface-container-high: '#282a2e'
  surface-container-highest: '#323539'
  on-surface: '#e1e2e7'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#e1e2e7'
  inverse-on-surface: '#2e3134'
  outline: '#849495'
  outline-variant: '#3a494b'
  surface-tint: '#00dbe7'
  primary: '#e1fdff'
  on-primary: '#00363a'
  primary-container: '#00f2ff'
  on-primary-container: '#006a71'
  inverse-primary: '#00696f'
  secondary: '#ffb4aa'
  on-secondary: '#690003'
  secondary-container: '#c5020b'
  on-secondary-container: '#ffd2cc'
  tertiary: '#f7f7ff'
  on-tertiary: '#2d3037'
  tertiary-container: '#d9dbe3'
  on-tertiary-container: '#5d6067'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#74f5ff'
  primary-fixed-dim: '#00dbe7'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f54'
  secondary-fixed: '#ffdad5'
  secondary-fixed-dim: '#ffb4aa'
  on-secondary-fixed: '#410001'
  on-secondary-fixed-variant: '#930005'
  tertiary-fixed: '#e1e2ea'
  tertiary-fixed-dim: '#c4c6ce'
  on-tertiary-fixed: '#191c22'
  on-tertiary-fixed-variant: '#44474d'
  background: '#111417'
  on-background: '#e1e2e7'
  surface-variant: '#323539'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.04em
  headline-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.1em
  mono-data:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: 0.02em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 40px
  container-max: 1440px
---

## Brand & Style

The design system is a high-fidelity intelligence interface that blends military-grade precision with the sophisticated aesthetics of modern computational design. It is engineered for high-performance environments where clarity, speed of data processing, and tactical awareness are paramount.

The visual style is a hybrid of **Glassmorphism** and **High-Contrast Modernism**. It leverages deep obsidian surfaces, localized frosted glass effects, and vibrant "Arc" glows to simulate a holographic head-up display (HUD). Every element should feel like a piece of advanced hardware software, utilizing subtle depth, light-leaks, and technical precision to evoke a sense of immense power and refined intelligence.

## Colors

The palette is strictly functional, rooted in a deep, "Vantablack-adjacent" foundation to maximize contrast for luminous data overlays.

- **Primary (Arc Cyan):** Used for active states, data visualizations, and focal points. It should frequently be applied as a glow effect (`drop-shadow`) to simulate light emission.
- **Secondary (Emergency Red):** Reserved exclusively for critical alerts, high-priority warnings, and destructive actions.
- **Surface (Obsidian & Charcoal):** The base layer is `#05070A`. Elevated containers use `#1A1D23` with 40-60% opacity to enable backdrop blurring.
- **Accents:** Low-opacity whites (10-20%) are used for subtle borders and grid lines to maintain a "blueprint" feel without distracting from the data.

## Typography

This design system utilizes **Inter** for its neutral, highly legible character in complex layouts, paired with **Geist** for technical data and labels. 

The typographic hierarchy prioritizes "scanability." Large display headers use tight tracking for a pressurized, high-tech look. Labels and data points are often set in uppercase with increased letter spacing to mimic military telemetry displays. Monospaced numerals (via Geist) must be used for all fluctuating data points to prevent layout shifting during real-time updates.

## Layout & Spacing

The layout follows a **Fixed Grid** model on desktop and a **Fluid Grid** on mobile, utilizing a 12-column architecture. 

A rigid 4px baseline grid ensures mathematical precision. Gutters are kept tight (16px) to maintain the dense, information-rich aesthetic of a cockpit HUD. Components should be grouped into "modules" that can be reflowed based on priority. On mobile, the interface collapses into a single-column stack, prioritizing circular "Arc" indicators and critical status labels at the top of the viewport.

## Elevation & Depth

Depth is not achieved through traditional drop shadows, but through **Tonal Layering and Glassmorphism**.

1.  **Level 0 (Base):** Solid Obsidian (#05070A).
2.  **Level 1 (Panels):** Semi-transparent Charcoal (#1A1D23 at 60% opacity) with a `backdrop-filter: blur(20px)`.
3.  **Level 2 (Active Modals):** Same as Level 1, but with a 1px solid border at 20% white and a subtle inner glow of Arc Cyan.
4.  **Indicators:** Active elements emit a "Primary Glow"—a diffuse, cyan outer shadow (`0px 0px 12px rgba(0, 242, 255, 0.3)`) that simulates light reflecting off a glass surface.

## Shapes

The shape language is "Soft-Technical." Use a consistent 0.25rem (4px) corner radius for most panels to maintain a precise, machined appearance. 

Circular shapes are reserved for "Arc" status indicators, biometric scans, and progress rings. Hexagonal or chamfered corners can be used sparingly for high-level tactical containers to reinforce the military-grade aesthetic.

## Components

- **Buttons:** Primary buttons are filled with Arc Cyan, featuring black text. Secondary buttons are "Ghost" style: 1px borders with 10% Cyan fill, transitioning to a glow on hover.
- **HUD Rings:** Circular progress indicators that use segmented strokes to show percentage-based data.
- **Input Fields:** Minimalist underlines or 1px borders. When focused, the border glows Cyan and the label shifts to the `label-caps` style above the field.
- **Chips/Status Tags:** Small, rectangular tags with no fill and a 1px border. Status is indicated by the text color (Cyan for Active, Red for Alert, White for Standby).
- **Cards:** Glassmorphic containers with thin, top-aligned accent lines.
- **Icons:** Use SF Symbols (or Inter-compatible monochrome icons). Icons should always be weight-matched to the surrounding text and never use multi-color fills.