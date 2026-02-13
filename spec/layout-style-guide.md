# FilaMan Layout Style Guide (Draft)

This file captures only the visual system: colors, surfaces, buttons, fields, cards, and spacing.

## Theme Tokens

```css
:root {
  --font-sans: "Space Grotesk", "Segoe UI", sans-serif;
  --font-serif: "Fraunces", "Georgia", serif;
  --radius-lg: 20px;
  --radius-md: 14px;
  --shadow-lg: 0 30px 80px rgba(0, 0, 0, 0.18);
  --shadow-md: 0 12px 30px rgba(0, 0, 0, 0.12);
  --shadow-sm: 0 6px 18px rgba(0, 0, 0, 0.08);
  --transition: 220ms ease;
}

html[data-theme="brand"] {
  --bg: #0c1612;
  --bg-elevated: #13261d;
  --bg-soft: #183225;
  --text: #e9f3ec;
  --text-muted: #b5c7bd;
  --accent: #4ee3a2;
  --accent-2: #6cc6ff;
  --accent-3: #f7c86a;
  --border: rgba(255, 255, 255, 0.08);
  --glow: 0 0 45px rgba(78, 227, 162, 0.35);
  --gradient-hero: radial-gradient(circle at 20% 20%, rgba(78, 227, 162, 0.25), transparent 60%),
    radial-gradient(circle at 80% 0%, rgba(108, 198, 255, 0.18), transparent 55%),
    linear-gradient(140deg, #0c1612 0%, #12251b 45%, #0b1410 100%);
}

html[data-theme="light"] {
  --bg: #f8f6f1;
  --bg-elevated: #ffffff;
  --bg-soft: #f1ece3;
  --text: #1a231e;
  --text-muted: #53645a;
  --accent: #1c9b6b;
  --accent-2: #2b7bc7;
  --accent-3: #d38e2c;
  --border: rgba(26, 35, 30, 0.12);
  --glow: 0 0 45px rgba(28, 155, 107, 0.18);
  --gradient-hero: radial-gradient(circle at 20% 20%, rgba(28, 155, 107, 0.16), transparent 60%),
    radial-gradient(circle at 80% 0%, rgba(43, 123, 199, 0.14), transparent 55%),
    linear-gradient(140deg, #f8f6f1 0%, #f1ece3 50%, #ffffff 100%);
}

html[data-theme="dark"] {
  --bg: #0b0d12;
  --bg-elevated: #141825;
  --bg-soft: #1a2032;
  --text: #eef1f7;
  --text-muted: #9aa4b7;
  --accent: #73d1ff;
  --accent-2: #8cf3b2;
  --accent-3: #f3a05f;
  --border: rgba(255, 255, 255, 0.08);
  --glow: 0 0 45px rgba(115, 209, 255, 0.35);
  --gradient-hero: radial-gradient(circle at 20% 20%, rgba(115, 209, 255, 0.25), transparent 60%),
    radial-gradient(circle at 80% 0%, rgba(140, 243, 178, 0.18), transparent 55%),
    linear-gradient(145deg, #0b0d12 0%, #0f1421 55%, #0b0d12 100%);
}
```

## Surfaces + Cards

```css
.page {
  min-height: 100vh;
  background: var(--gradient-hero);
}

.card {
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  padding: 18px;
  box-shadow: var(--shadow-sm);
  transition: transform var(--transition), box-shadow var(--transition);
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-md);
}

.hero-panel {
  background: var(--bg-elevated);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  padding: 24px;
  box-shadow: var(--shadow-lg);
  position: relative;
  overflow: hidden;
}
```

## Buttons

```css
.btn {
  padding: 12px 20px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
  transition: transform var(--transition), box-shadow var(--transition), background var(--transition);
}

.btn-primary {
  background: var(--accent);
  color: #0b120e;
  box-shadow: var(--glow);
}

.btn-primary:hover {
  transform: translateY(-2px);
}

.btn-outline {
  background: transparent;
  border-color: var(--border);
  color: var(--text);
}
```

## Fields (Input / Select / Textarea)

Use these for later screens; they match the card + soft-surface look.

```css
.field {
  display: grid;
  gap: 6px;
  font-size: 0.9rem;
}

.field label {
  color: var(--text-muted);
}

.field input,
.field select,
.field textarea {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  color: var(--text);
  font-family: var(--font-sans);
  transition: border-color var(--transition), box-shadow var(--transition);
}

.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(78, 227, 162, 0.18);
}

.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-muted);
}
```

## Pills / Chips / Status

```css
.pill,
.status,
.chip {
  border: 1px solid var(--border);
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.8rem;
  color: var(--text-muted);
  background: var(--bg-soft);
}
```

## Sidebar Nav

```css
.sidebar {
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  color: var(--text-muted);
  transition: background var(--transition), color var(--transition);
}

.nav-item:hover,
.nav-item.active {
  background: var(--bg-soft);
  color: var(--text);
}
```
