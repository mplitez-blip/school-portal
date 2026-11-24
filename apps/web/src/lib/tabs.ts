/**
 * Accessible tabbed interface controller following modern-web-guidance:
 * - Conditional @microsoft/focusgroup-polyfill when native focusgroup is unavailable
 * - Selection follows focus + click activation
 * - hidden="until-found" + beforematch find-in-page synchronization
 * - Horizontal scrollIntoView({ container: 'nearest' }) & IntersectionObserver fade fallback
 */

let polyfillLoaded = false;

async function ensureFocusgroupPolyfill(): Promise<void> {
  if (polyfillLoaded) return;
  polyfillLoaded = true;
  if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
    const { polyfill } = await import('@microsoft/focusgroup-polyfill');
    polyfill(document.body);
  }
}

export interface TabsController {
  selectById: (tabId: string) => void;
  refreshScrollHints: () => void;
}

export function initTabs(container: HTMLElement): TabsController {
  void ensureFocusgroupPolyfill();

  const tablist = container.querySelector<HTMLElement>('[focusgroup]');
  const getTabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const getPanels = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

  const selectTab = (selected: HTMLButtonElement, scroll = true) => {
    const tabs = getTabs();
    const panels = getPanels();

    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.toggleAttribute('focusgroupstart', active);
    }

    for (const panel of panels) {
      const matches = panel.getAttribute('aria-labelledby') === selected.id;
      if (matches) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', 'until-found');
      }
    }

    if (scroll) {
      try {
        (selected as HTMLElement & { scrollIntoView: (opts: unknown) => void }).scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          container: 'nearest',
        });
      } catch {
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  };

  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('.tab-btn');
    if (target && container.contains(target)) {
      selectTab(target);
    }
  });

  // Selection follows focus on keyboard navigation within the tablist
  tablist?.addEventListener('focusin', (e) => {
    const target = e.target;
    if (target instanceof HTMLButtonElement && target.classList.contains('tab-btn')) {
      selectTab(target);
    }
  });

  // Sync tab selection if browser find-in-page reveals a hidden="until-found" panel
  container.addEventListener(
    'beforematch',
    (e) => {
      const panel = (e.target as HTMLElement | null)?.closest<HTMLElement>('[role="tabpanel"]');
      if (!panel) return;
      const tabId = panel.getAttribute('aria-labelledby');
      if (!tabId) return;
      const tab = container.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId)}`);
      if (tab) selectTab(tab);
    },
    true
  );

  let fadeObserver: IntersectionObserver | null = null;
  const refreshScrollHints = () => {
    if (!tablist || CSS.supports('animation-timeline', 'scroll()')) return;
    fadeObserver?.disconnect();
    const first = tablist.firstElementChild;
    const last = tablist.lastElementChild;
    if (!first || !last) return;

    fadeObserver = new IntersectionObserver(
      (entries) => {
        for (const { target, intersectionRatio } of entries) {
          tablist.classList.toggle(target === first ? 'more-start' : 'more-end', intersectionRatio < 1);
        }
      },
      { root: tablist, threshold: 1, rootMargin: '1px' }
    );
    fadeObserver.observe(first);
    fadeObserver.observe(last);
  };

  refreshScrollHints();

  return {
    selectById(tabId: string) {
      const tab = container.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId)}`);
      if (tab) selectTab(tab, false);
    },
    refreshScrollHints,
  };
}
