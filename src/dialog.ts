/**
 * Modal dialogs — the open/close mechanics the Guide, About and port-picker
 * overlays share, so each behaves as a dialog for a keyboard and for assistive
 * technology, not just for a mouse: opening moves focus into it, Tab stays
 * inside it, and closing hands focus back to whatever opened it. (The roles —
 * `role="dialog"`, `aria-modal`, `aria-labelledby` — are static, in
 * template.html.) Presentation only; no state of the app's lives here.
 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// What had focus when each overlay opened, to give it back on close.
const openers = new Map<HTMLElement, HTMLElement | null>();
const trapped = new Set<HTMLElement>();

// Keep Tab inside the dialog: past the last control wraps to the first, and
// Shift+Tab before the first wraps to the last.
function trapTab(overlay: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !overlay.classList.contains("open")) return;
  const controls = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || !overlay.contains(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || !overlay.contains(active))) { event.preventDefault(); first.focus(); }
}

// Show an overlay as a modal dialog and move focus to `focus` (its close
// button, usually) so the next key press acts inside it.
export function showDialog(overlay: HTMLElement, focus?: HTMLElement | null): void {
  if (!overlay.classList.contains("open")) openers.set(overlay, document.activeElement as HTMLElement | null);
  overlay.classList.add("open");
  if (!trapped.has(overlay)) {
    trapped.add(overlay);
    overlay.addEventListener("keydown", (event) => trapTab(overlay, event as KeyboardEvent));
  }
  focus?.focus?.();
}

// Hide it and return focus to the control that opened it (if it still exists).
export function hideDialog(overlay: HTMLElement): void {
  const wasOpen = overlay.classList.contains("open");
  overlay.classList.remove("open");
  if (!wasOpen) return;
  const opener = openers.get(overlay);
  openers.delete(overlay);
  if (opener && opener.isConnected !== false) opener.focus?.();
}
