# DESIGN_MEMORY — litectx UI

## Brand Tone
- Adjectives: simple, functional, terminal-like, lightweight.
- Avoid: anything fancy, frameworks, heavy visuals, shadows, rounded cards, wordy labels.

## Layout & Spacing
- Compact. Single column; a side view opens to the right (3fr / 2fr), and stacks below 700px.
- Order from top to bottom:
  - Top bar: always two lines — source + count/status on the left; the control group (re-index, meaning, …) on its own line, right-aligned.
  - Search line.
  - **One** filter line, groups set apart by spacing (no separator glyphs).
  - View switch line.
  - Results.
- Square chips, 1px borders, no shadows.

## Typography
- Monospace only, Courier New first. 14px body, 13px meta, 12px hints.

## Color
- Tokyo Night Day (light) and Tokyo Night (dark), auto by system with a manual toggle.
- **Meaning:**
  - cyan = doc, green = code
  - yellow = keyword match, orange = meaning-only
  - magenta = repo/section
  - blue = links and active controls

## Interaction Patterns
- Filters are toggle chips with short labels; long explanations go in the tooltip (`title`), never in the label.
- Choosing from many items (repos) uses a typed input with live suggestions, not a wall of chips.
- Suggest options from what is on screen (folders taken from the current results).
- Hover gives a quick look; click opens a side view; Esc closes it.
- A two-state choice is a sliding switch that shows both names, the current one bold. Not a button that names the other state.
- Keep related controls together: view switch next to the results, filter knobs in the filter line.

## Accessibility Rules
- Visible `:focus-visible`, keyboard-reachable rows, `role="switch"` for switches, `prefers-reduced-motion` honoured.

## Repo Conventions
- Plain JS + inline CSS custom properties, no build step, no dependencies (litectx library doctrine).
- Server binds 127.0.0.1; file views are confined to the indexed root.
