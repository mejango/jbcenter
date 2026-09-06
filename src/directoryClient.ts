/** Browser-only enhancement of the complete, server-rendered directory. */
export const HOMEPAGE_JS = String.raw`(() => {
  'use strict';

  const flow = document.querySelector('.flow');
  if (!flow) return;
  const svg = flow.querySelector('svg.flow-lines');
  const start = flow.querySelector('.flow-start');
  const tasks = flow.querySelector('.flow-tasks');
  const results = flow.querySelector('.flow-results');
  if (!svg || !start || !tasks || !results) return;
  const buttons = Array.from(tasks.querySelectorAll('button[data-task]'));
  const panels = Array.from(results.querySelectorAll('.task-panel[data-task]'));
  const entries = new Map();
  for (const button of buttons) {
    const panel = panels.find((candidate) => candidate.dataset.task === button.dataset.task);
    if (!panel || entries.has(button.dataset.task)) return;
    entries.set(button.dataset.task, { button, panel });
  }
  if (!entries.has('apps') || entries.size !== panels.length) return;

  const mobile = window.matchMedia('(max-width: 760px)');
  const managedToggles = new WeakSet();
  let selected = 'apps';
  let frame = 0;
  let routedHash = '';

  function hashId() {
    try { return decodeURIComponent(window.location.hash.slice(1)); }
    catch { return ''; }
  }

  function route() {
    const id = hashId();
    if (entries.has(id)) return { task: id, detail: null };
    const detail = id ? document.getElementById(id) : null;
    const panel = detail && detail.matches('details') && detail.closest('.task-panel');
    if (panel && entries.get(panel.dataset.task)?.panel === panel) {
      return { task: panel.dataset.task, detail };
    }
    return { task: 'apps', detail: null };
  }

  function setOpen(detail, open) {
    if (detail.open === open) return;
    managedToggles.add(detail);
    detail.open = open;
  }

  function focusPanel(panel) {
    const heading = panel.querySelector('.panel-title');
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function applyRoute(moveFocus) {
    const next = route();
    const previous = entries.get(selected);
    const previouslyFocused = document.activeElement;
    const focusedPanelWillHide = previous && previous.panel.contains(previouslyFocused)
      && next.task !== selected;
    selected = next.task;
    routedHash = window.location.hash;
    for (const [task, entry] of entries) {
      const active = task === selected;
      entry.panel.hidden = !active;
      entry.button.classList.toggle('selected', active);
      entry.button.setAttribute('aria-expanded', String(active));
    }
    const panel = entries.get(selected).panel;
    const ancestors = new Set();
    let ancestor = next.detail;
    while (ancestor && panel.contains(ancestor)) {
      if (ancestor.matches('details')) ancestors.add(ancestor);
      ancestor = ancestor.parentElement;
    }
    for (const detail of panel.querySelectorAll('details')) {
      setOpen(detail, ancestors.has(detail));
    }
    const focusedBranchDidHide = panel.contains(previouslyFocused) && !visible(previouslyFocused);
    if (moveFocus || focusedPanelWillHide || focusedBranchDidHide) {
      if (mobile.matches) focusPanel(panel);
      else entries.get(selected).button.focus({ preventScroll: true });
    }
    scheduleDraw();
  }

  function writeHash(id) {
    const hash = '#' + encodeURIComponent(id);
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    routedHash = window.location.hash;
  }

  tasks.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-task]');
    if (!button || !tasks.contains(button) || !entries.has(button.dataset.task)) return;
    writeHash(button.dataset.task);
    applyRoute(mobile.matches);
  });

  results.addEventListener('click', (event) => {
    const back = event.target.closest('button[data-back]');
    if (!back || !results.contains(back)) return;
    const button = entries.get(selected).button;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'center', behavior: 'auto' });
  });

  function historyChanged() {
    if (routedHash !== window.location.hash) applyRoute(false);
  }
  window.addEventListener('hashchange', historyChanged);
  window.addEventListener('popstate', historyChanged);

  flow.addEventListener('toggle', (event) => {
    scheduleDraw();
    const detail = event.target;
    if (!detail.matches('details')) return;
    if (managedToggles.has(detail)) {
      managedToggles.delete(detail);
      return;
    }
    const panel = entries.get(selected).panel;
    if (!detail.id || !panel.contains(detail)) return;
    // Named sibling disclosures may close and open in the same interaction.
    // Read their final DOM state rather than routing from one queued event.
    const open = Array.from(panel.querySelectorAll('details[id][open]'))
      .filter((candidate) => visible(candidate));
    writeHash(open.length ? open[open.length - 1].id : selected);
  }, true);

  function visible(element) {
    if (!element || element.closest('[hidden]')) return false;
    for (let parent = element.parentElement; parent && parent !== flow; parent = parent.parentElement) {
      if (parent.matches('details:not([open])')) {
        const summary = parent.querySelector(':scope > summary');
        if (!summary || !summary.contains(element)) return false;
      }
    }
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function immediateNodes(container) {
    const nodes = [];
    function walk(parent) {
      for (const child of parent.children) {
        if (child.matches('[data-flow-node]')) {
          if (visible(child)) nodes.push(child);
        } else if (child.matches('details')) {
          const summary = child.querySelector(':scope > summary[data-flow-node]');
          if (visible(summary)) nodes.push(summary);
        } else if (!child.matches('svg')) {
          walk(child);
        }
      }
    }
    walk(container);
    return nodes;
  }

  function scheduleDraw() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    const bounds = flow.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const namespace = 'http://www.w3.org/2000/svg';
    const fragment = document.createDocumentFragment();
    function element(name, attributes) {
      const node = document.createElementNS(namespace, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    }
    const definitions = element('defs', {});
    const arrow = element('marker', {
      id: 'flow-arrow', markerWidth: 6, markerHeight: 6,
      refX: 6, refY: 3, orient: 'auto', markerUnits: 'userSpaceOnUse',
    });
    arrow.append(element('polygon', { points: '0 0,6 3,0 6', fill: 'context-stroke' }));
    definitions.append(arrow);
    fragment.append(definitions);

    function box(node) {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left - bounds.left, right: rect.right - bounds.left,
        top: rect.top - bounds.top, bottom: rect.bottom - bounds.top,
        x: rect.left - bounds.left + rect.width / 2,
        y: rect.top - bounds.top + rect.height / 2,
      };
    }
    function path(data, active) {
      fragment.append(element('path', {
        d: data, class: active ? 'active' : '', fill: 'none',
        'marker-end': 'url(#flow-arrow)',
      }));
    }
    function horizontal(source, targets, active) {
      if (!targets.length) return;
      const bus = source.right + (Math.min(...targets.map((target) => target.left)) - source.right) / 2;
      for (const target of targets) {
        path('M ' + source.right + ' ' + source.y + ' H ' + bus
          + ' V ' + target.y + ' H ' + (target.left - 2), active);
      }
    }
    function vertical(source, targets, gutter, active) {
      for (const target of targets) {
        path('M ' + source.x + ' ' + source.bottom + ' V ' + (source.bottom + 6)
          + ' H ' + gutter + ' V ' + target.y + ' H ' + (target.left - 2), active);
      }
    }

    const root = box(start);
    const taskBoxes = buttons.filter(visible).map((button) => ({
      node: button, bounds: box(button), active: button.dataset.task === selected,
    })).sort((a, b) => Number(a.active) - Number(b.active));
    if (mobile.matches) {
      const gutter = Math.max(2, Math.min(...taskBoxes.map((task) => task.bounds.left)) - 12);
      for (const task of taskBoxes) vertical(root, [task.bounds], gutter, task.active);
    } else {
      for (const task of taskBoxes) horizontal(root, [task.bounds], task.active);
    }

    const entry = entries.get(selected);
    const children = immediateNodes(entry.panel);
    const targets = children.map(box);
    if (visible(entry.button) && targets.length) {
      const source = box(entry.button);
      if (mobile.matches) {
        const gutter = Math.max(2, Math.min(source.left, ...targets.map((target) => target.left)) - 22);
        vertical(source, targets, gutter, true);
      } else {
        horizontal(source, targets, true);
      }
    }
    for (const detail of entry.panel.querySelectorAll('details[open]')) {
      const summary = detail.querySelector(':scope > summary[data-flow-node]');
      const content = detail.querySelector(':scope > .branch-content');
      if (!visible(summary) || !content) continue;
      const nested = immediateNodes(content).map(box);
      if (!nested.length) continue;
      const source = box(summary);
      const gutter = Math.max(source.left + 6, Math.min(...nested.map((node) => node.left)) - 12);
      source.x = gutter;
      vertical(source, nested, gutter, true);
    }
    svg.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height);
    svg.setAttribute('width', String(bounds.width));
    svg.setAttribute('height', String(bounds.height));
    svg.replaceChildren(fragment);
  }

  flow.classList.add('is-enhanced');
  applyRoute(false);
  window.addEventListener('resize', scheduleDraw, { passive: true });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleDraw);
    for (const node of [flow, start, tasks, results]) observer.observe(node);
  }
  if (document.fonts) document.fonts.ready.then(scheduleDraw);
})();
`;
