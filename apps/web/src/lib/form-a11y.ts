/**
 * Keeps aria-invalid and aria-describedby synchronized with :user-invalid
 * (with fallback for browsers without :user-invalid) and announces field
 * errors politely through a single page-level live region.
 */
export function initAccessibleValidation(root: ParentNode = document): void {
  const supportsUserInvalid = typeof CSS !== 'undefined' && CSS.supports('selector(:user-invalid)');
  const dirtyState = new WeakMap<HTMLElement, { hasInteracted: boolean; hasBlurred: boolean }>();
  const flagged = new WeakSet<HTMLElement>();
  const announced = new WeakSet<HTMLElement>();

  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);

  let announceTimer: number | undefined;
  let announcedField: HTMLElement | null = null;

  const linkError = (el: HTMLElement, shown: boolean) => {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  };

  const spokenText = (node: Element): string => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    copy.querySelectorAll('[role="img"][aria-label]').forEach((n) => {
      n.replaceWith(`${n.getAttribute('aria-label')}: `);
    });
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const announceError = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const errorEl = document.getElementById(errorId);
    if (!errorEl) return;
    const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
    window.clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = el;
    announceTimer = window.setTimeout(() => {
      announcer.textContent = label + spokenText(errorEl);
    }, 500);
  };

  const isField = (
    target: EventTarget | null
  ): target is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    target instanceof HTMLElement && target.matches('input, select, textarea');

  const syncAria = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, announce = false) => {
    let invalid = false;
    if (supportsUserInvalid) {
      invalid = el.matches(':user-invalid');
    } else {
      const state = dirtyState.get(el);
      invalid = Boolean(state?.hasInteracted && state?.hasBlurred && !el.validity.valid);
      el.classList.toggle('user-invalid-fallback', invalid);
    }

    if (invalid) {
      if (announce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute('aria-invalid', 'true');
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
      el.setAttribute('aria-invalid', 'false');
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        window.clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input, select, textarea'
  ).forEach((el) => {
    if (!el.hasAttribute('aria-invalid')) {
      el.setAttribute('aria-invalid', 'false');
    }
  });

  root.addEventListener(
    'blur',
    (e) => {
      if (!isField(e.target)) return;
      const state = dirtyState.get(e.target) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(e.target, state);
      syncAria(e.target, true);
    },
    true
  );

  root.addEventListener('input', (e) => {
    if (!isField(e.target)) return;
    const state = dirtyState.get(e.target) || { hasInteracted: false, hasBlurred: false };
    state.hasInteracted = true;
    dirtyState.set(e.target, state);
    if (e.target.hasAttribute('aria-invalid')) {
      syncAria(e.target, false);
    }
  });

  root.addEventListener(
    'change',
    (e) => {
      if (!isField(e.target)) return;
      const state = dirtyState.get(e.target) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyState.set(e.target, state);
      syncAria(e.target, true);
    },
    true
  );

  root.addEventListener(
    'invalid',
    (e) => {
      if (!isField(e.target)) return;
      dirtyState.set(e.target, { hasInteracted: true, hasBlurred: true });
      announced.add(e.target);
      syncAria(e.target, false);
    },
    true
  );

  root.addEventListener(
    'reset',
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      window.setTimeout(() => {
        for (const el of Array.from(form.elements)) {
          if (isField(el)) {
            dirtyState.delete(el);
            el.classList.remove('user-invalid-fallback');
            syncAria(el, false);
          }
        }
      });
    },
    true
  );
}
