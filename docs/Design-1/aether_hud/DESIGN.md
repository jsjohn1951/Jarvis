---
name: Aether HUD
colors:
  surface: '#0f131d'
  surface-dim: '#0f131d'
  surface-bright: '#353944'
  surface-container-lowest: '#0a0e18'
  surface-container-low: '#171b26'
  surface-container: '#1c1f2a'
  surface-container-high: '#262a35'
  surface-container-highest: '#313540'
  on-surface: '#dfe2f1'
  on-surface-variant: '#b9cacb'
  inverse-surface: '#dfe2f1'
  inverse-on-surface: '#2c303b'
  outline: '#849495'
  outline-variant: '#3a494b'
  surface-tint: '#00dbe7'
  primary: '#e1fdff'
  on-primary: '#00363a'
  primary-container: '#00f2ff'
  on-primary-container: '#006a71'
  inverse-primary: '#00696f'
  secondary: '#98cbff'
  on-secondary: '#003354'
  secondary-container: '#00a2fd'
  on-secondary-container: '#003558'
  tertiary: '#fff5f4'
  on-tertiary: '#680008'
  tertiary-container: '#ffd0cb'
  on-tertiary-container: '#c20018'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#74f5ff'
  primary-fixed-dim: '#00dbe7'
  on-primary-fixed: '#002022'
  on-primary-fixed-variant: '#004f54'
  secondary-fixed: '#cfe5ff'
  secondary-fixed-dim: '#98cbff'
  on-secondary-fixed: '#001d33'
  on-secondary-fixed-variant: '#004a77'
  tertiary-fixed: '#ffdad6'
  tertiary-fixed-dim: '#ffb3ac'
  on-tertiary-fixed: '#410003'
  on-tertiary-fixed-variant: '#930010'
  background: '#0f131d'
  on-background: '#dfe2f1'
  surface-variant: '#313540'
typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.02em
  headline-md-mobile:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.2'
  body-base:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
    letterSpacing: 0.01em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.0'
    letterSpacing: 0.1em
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.4'
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-margin: 32px
  gutter: 16px
  panel-padding: 24px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style
The design system is a sophisticated, high-fidelity interface inspired by advanced heads-up displays (HUD) and futuristic holographic systems. It is designed for power users who require reactive data visualization and a sense of absolute control. The aesthetic merges **Glassmorphism** with **Technical Minimalism**, creating a "layered light" effect where information appears to float in a deep-space vacuum.

The interface should feel alive; every interaction must evoke a sense of machine intelligence responding to human intent. The style is characterized by precision, utilizing razor-thin lines, glowing accents, and a strict adherence to a digital-first, futuristic architecture.

## Colors
The palette is rooted in the "Deep Space" (#0B0F19) foundation to provide maximum contrast for luminescent elements. 
- **Electric Cyan** is the primary action color, used for critical data, active states, and primary focal points.
- **Neon Blue** serves as the secondary layer, used for secondary navigation and supportive UI elements.
- **Data Red** is reserved strictly for alerts, errors, or critical system warnings to ensure immediate visual hierarchy.
- **Glass Surfaces** utilize low-opacity variants of the neutral palette to create depth without sacrificing legibility.

## Typography
Typography in this design system balances human readability with technical aesthetics. **Space Grotesk** provides a futuristic, geometric feel for headlines, while **Inter** ensures that dense data remains legible in body text. **JetBrains Mono** is utilized for metadata, labels, and system readings to reinforce the "code-based" or HUD-driven narrative. 

All labels should default to uppercase with slight tracking (letter spacing) to mimic instrument panel readouts. Text that represents dynamic system values should always use the monospaced "data-mono" role to prevent layout jitter during value updates.

## Layout & Spacing
The layout follows a **Fixed Grid** system with a technical underlay. A subtle 32px background grid should be visible at low opacity (2-4%) to guide the eye and reinforce the HUD aesthetic.

- **Desktop:** 12-column grid, 32px margins, 16px gutters. Panels are often pinned to corners to simulate a cockpit viewpoint.
- **Tablet:** 8-column grid, 24px margins.
- **Mobile:** 4-column grid, 16px margins. Information is stacked vertically, but maintain the "floating" panel feel by using inset margins for all containers.

Use a 4px base unit for all micro-spacing to maintain mathematical precision.

## Elevation & Depth
Depth is achieved through **Glassmorphism** rather than traditional drop shadows. 
- **Base Layer:** Deep Space Navy with a subtle radial gradient.
- **Mid Layer:** Semi-transparent panels (Background Blur: 12px to 20px) with a 1px inner border of Electric Cyan at 20% opacity.
- **Top Layer:** Active elements or modals utilize a stronger "outer glow" (box-shadow: 0 0 15px primary_color_hex) to simulate light emission.

Avoid solid backgrounds; every container should feel like a pane of glass catching the light from the UI elements themselves.

## Shapes
The shape language is "Soft-Technical." Use 0.25rem (4px) corner radii for standard containers to keep them feeling sharp and engineered, but not aggressive. Circular motifs (100% roundedness) are reserved for data rings, scanning animations, and status indicators to contrast against the rigid rectangular grid. 

Decorative "corner brackets" may be used on primary panels to emphasize the HUD framing.

## Components
- **Buttons:** Ghost-style by default with 1px Cyan borders. On hover, the background fills with a 10% Cyan tint and the border glow intensifies. Text is always uppercase.
- **Input Fields:** Bottom-border only, or a fully enclosed glass container with a "scanning" line animation on focus.
- **Cards/Panels:** Must include a "Header" section with a monospaced ID tag (e.g., [SEC-01]) in the top left corner.
- **Chips:** Small, pill-shaped outlines with a dot indicator for status (Active: Cyan, Idle: Blue, Warning: Red).
- **Data Rings:** Circular progress bars with segmented strokes to show loading or capacity levels.
- **HUD Brackets:** L-shaped decorative elements placed at the corners of high-priority images or video feeds.