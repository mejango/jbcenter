/** Browser navigation and decorative connectors for the authored question maps. */
export const HOMEPAGE_JS = String.raw`(() => {
  'use strict';

  const explorer = document.querySelector('.journey-explorer');
  if (!explorer) return;
  const tabs = explorer.querySelector('.journey-tabs');
  const maps = new Map();
  if (!tabs) return;
  for (const panel of explorer.querySelectorAll('.journey-map[data-view]')) {
    const view = panel.dataset.view;
    const button = Array.from(tabs.querySelectorAll('button[data-view]'))
      .find((candidate) => candidate.dataset.view === view);
    const svg = panel.querySelector('svg.journey-lines');
    const nodes = new Map();
    for (const node of panel.querySelectorAll('.journey-node[data-node]')) {
      if (nodes.has(node.dataset.node)) return;
      nodes.set(node.dataset.node, node);
    }
    if (!button || !svg || !nodes.has(panel.dataset.entry) || maps.has(view)) return;
    maps.set(view, {
      view, panel, button, svg, nodes, entry: panel.dataset.entry,
      edges: Array.from(panel.querySelectorAll('a.journey-edge[data-from][data-to]')),
    });
  }
  if (!maps.has('apps')) return;

  const mobile = window.matchMedia('(max-width: 760px)');
  const expandable = new Set(['rpc', 'ipfs', 'pinning', 'mcp']);
  let current = { view: 'apps', node: maps.get('apps').entry };
  let incoming = null;
  let routedKey = '';
  let frame = 0;

  function route() {
    let id = '';
    try { id = decodeURIComponent(window.location.hash.slice(1)); }
    catch { /* An invalid fragment falls back to the entry question. */ }
    if (maps.has(id)) return { view: id, node: maps.get(id).entry };
    if (['rpc', 'ipfs', 'pinning'].includes(id) && maps.get('api')?.nodes.has(id)) {
      return { view: 'api', node: id };
    }
    const slash = id.indexOf('/');
    if (slash > 0) {
      const view = id.slice(0, slash);
      const node = id.slice(slash + 1);
      if (maps.get(view)?.nodes.has(node)) return { view, node };
    }
    return { view: 'apps', node: maps.get('apps').entry };
  }

  function historyKey() {
    const state = window.history.state?.juiceboxDirectory;
    return JSON.stringify([window.location.hash, state?.view, state?.node, state?.fromView, state?.from]);
  }

  function focusNode(node) {
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: mobile.matches ? 'start' : 'nearest', inline: 'nearest', behavior: 'auto' });
  }

  function applyRoute(moveFocus) {
    const next = route();
    const previousMap = maps.get(current.view);
    const previousFocus = document.activeElement;
    const focusWillHide = current.view !== next.view && previousMap.panel.contains(previousFocus);
    current = next;
    const state = window.history.state?.juiceboxDirectory;
    incoming = state && state.view === current.view && state.node === current.node
      && maps.get(state.fromView)?.nodes.has(state.from)
      ? { view: state.fromView, node: state.from }
      : null;
    for (const [view, map] of maps) {
      const selected = view === current.view;
      map.panel.hidden = !selected;
      map.button.classList.toggle('selected', selected);
      map.button.setAttribute('aria-expanded', String(selected));
      for (const [id, node] of map.nodes) node.classList.toggle('current', selected && id === current.node);
      for (const edge of map.edges) {
        const active = selected && incoming?.view === view && edge.dataset.from === incoming.node
          && edge.dataset.to === current.node && (edge.dataset.targetView || view) === current.view;
        edge.classList.toggle('active', active);
      }
    }
    const node = maps.get(current.view).nodes.get(current.node);
    if (expandable.has(node.dataset.content)) {
      const reference = node.querySelector('details.node-reference');
      if (reference) reference.open = true;
    }
    routedKey = historyKey();
    if (moveFocus || focusWillHide) focusNode(node);
    scheduleDraw();
  }

  function navigate(view, node, from, moveFocus) {
    if (!maps.get(view)?.nodes.has(node)) return;
    const hash = '#' + encodeURIComponent(view) + '/' + encodeURIComponent(node);
    const previousState = window.history.state;
    const state = {
      ...(previousState && typeof previousState === 'object' ? previousState : {}),
      juiceboxDirectory: { view, node, fromView: from?.view, from: from?.node },
    };
    if (window.location.hash === hash) window.history.replaceState(state, '', hash);
    else window.history.pushState(state, '', hash);
    applyRoute(moveFocus);
  }

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button || !tabs.contains(button)) return;
    const map = maps.get(button.dataset.view);
    if (map) navigate(map.view, map.entry, null, mobile.matches);
  });

  explorer.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const edge = event.target.closest('a.journey-edge[data-from][data-to]');
    const panel = edge?.closest('.journey-map');
    const source = panel && maps.get(panel.dataset.view);
    if (!source || !source.edges.includes(edge) || !source.nodes.has(edge.dataset.from)) return;
    const view = edge.dataset.targetView || source.view;
    if (!maps.get(view)?.nodes.has(edge.dataset.to)) return;
    event.preventDefault();
    navigate(view, edge.dataset.to, { view: source.view, node: edge.dataset.from }, true);
  });

  function historyChanged() {
    if (historyKey() !== routedKey) applyRoute(true);
  }
  window.addEventListener('hashchange', historyChanged);
  window.addEventListener('popstate', historyChanged);
  explorer.addEventListener('toggle', scheduleDraw, true);

  function visible(node) {
    if (!node || node.closest('[hidden]')) return false;
    for (let parent = node.parentElement; parent && parent !== explorer; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(node)) return false;
    }
    const bounds = node.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function scheduleDraw() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    const map = maps.get(current.view);
    const bounds = map.panel.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const namespace = 'http://www.w3.org/2000/svg';
    const fragment = document.createDocumentFragment();
    function element(name, attributes) {
      const node = document.createElementNS(namespace, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      return node;
    }
    const markerId = 'journey-arrow-' + map.view;
    const definitions = element('defs', {});
    const arrow = element('marker', {
      id: markerId, markerWidth: 7, markerHeight: 7, refX: 7, refY: 3.5,
      orient: 'auto', markerUnits: 'userSpaceOnUse',
    });
    arrow.append(element('polygon', { points: '0 0,7 3.5,0 7', fill: 'context-stroke' }));
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
    const boxes = new Map();
    for (const [id, node] of map.nodes) if (visible(node)) boxes.set(id, box(node));
    const allBoxes = Array.from(boxes.values());

    function beforeRow(target) {
      const previous = allBoxes.filter((node) => node.bottom < target.top - 2);
      const bottom = previous.length ? Math.max(...previous.map((node) => node.bottom)) : target.top - 24;
      return target.top - Math.min(24, Math.max(6, (target.top - bottom) / 2));
    }
    function afterRow(source) {
      const peers = allBoxes.filter((node) => Math.abs(node.top - source.top) < 2);
      const bottom = Math.max(source.bottom, ...peers.map((node) => node.bottom));
      const next = allBoxes.filter((node) => node.top > bottom + 2);
      const top = next.length ? Math.min(...next.map((node) => node.top)) : bounds.height;
      return Math.min(bounds.height - 6, bottom + Math.min(24, Math.max(6, (top - bottom) / 2)));
    }
    function clear(points, source, target) {
      for (let index = 1; index < points.length; index++) {
        const [x1, y1] = points[index - 1];
        const [x2, y2] = points[index];
        for (const node of allBoxes) {
          if (node === source || node === target) continue;
          if (x1 === x2 && x1 > node.left - 2 && x1 < node.right + 2
            && Math.max(y1, y2) > node.top - 2 && Math.min(y1, y2) < node.bottom + 2) return false;
          if (y1 === y2 && y1 > node.top - 2 && y1 < node.bottom + 2
            && Math.max(x1, x2) > node.left - 2 && Math.min(x1, x2) < node.right + 2) return false;
        }
      }
      return true;
    }
    function outerLane(left, lane) {
      const offset = mobile.matches ? 2 + lane * 2 : 4 + lane * 4;
      return left ? offset : bounds.width - offset;
    }
    function localLane(node, left, lane) {
      const coordinate = left ? node.left - 16 - lane * 4 : node.right + 16 + lane * 4;
      return Math.max(outerLane(true, lane), Math.min(outerLane(false, lane), coordinate));
    }
    function routeEdge(source, target, edge, index) {
      const lane = Math.floor(index / 2) % 3;
      const y = box(edge).y;
      const targetY = Math.min(target.y, target.top + 28 + lane * 5);
      const preferredLeft = mobile.matches ? index % 2 === 1 : source.x + target.x < bounds.width;
      const sides = [preferredLeft, !preferredLeft];
      const sourcePort = (left) => [left ? source.left : source.right, y];
      const targetPort = (left) => [left ? target.left - 2 : target.right + 2, targetY];

      // Adjacent columns have a clear channel between their cards. Depart at
      // the actual choice row so a line cannot imply a different decision.
      if (!mobile.matches && edge.dataset.kind !== 'return') {
        if (target.left > source.right + 12) {
          const bus = source.right + Math.min(20 + lane * 5, (target.left - source.right) / 2);
          const candidate = [sourcePort(false), [bus, y], [bus, targetY], targetPort(true)];
          if (clear(candidate, source, target)) return candidate;
        }
        if (target.right < source.left - 12) {
          const bus = source.left - Math.min(20 + lane * 5, (source.left - target.right) / 2);
          const candidate = [sourcePort(true), [bus, y], [bus, targetY], targetPort(false)];
          if (clear(candidate, source, target)) return candidate;
        }
        // A vertical choice can travel beside its column without joining all
        // the intervening cards. This remains a single, directed connection.
        for (const left of sides) {
          const bus = left ? Math.min(localLane(source, true, lane), localLane(target, true, lane))
            : Math.max(localLane(source, false, lane), localLane(target, false, lane));
          const candidate = [sourcePort(left), [bus, y], [bus, targetY], targetPort(left)];
          if (clear(candidate, source, target)) return candidate;
        }
      }

      // On phones these distinct outer lanes connect the real choice rows.
      // Returns also use the outer lanes on desktop, making their direction
      // separate from the forward question sequence.
      for (const left of sides) {
        const bus = outerLane(left, lane);
        const candidate = [sourcePort(left), [bus, y], [bus, targetY], targetPort(left)];
        if (clear(candidate, source, target)) return candidate;
      }
      // Middle-column cards may need a row gap before reaching an outer lane.
      // Try both sides and row gaps; never accept an unchecked fallback.
      for (const outsideLeft of sides) {
        const bus = outerLane(outsideLeft, lane);
        for (const sourceLeft of [outsideLeft, !outsideLeft]) {
          const exit = localLane(source, sourceLeft, lane);
          for (const targetLeft of [outsideLeft, !outsideLeft]) {
            const entrance = localLane(target, targetLeft, lane);
            for (const sourceRow of [afterRow(source), beforeRow(source)]) {
              for (const targetRow of [beforeRow(target), afterRow(target)]) {
                const candidate = [sourcePort(sourceLeft), [exit, y], [exit, sourceRow],
                  [bus, sourceRow], [bus, targetRow], [entrance, targetRow],
                  [entrance, targetY], targetPort(targetLeft)];
                if (clear(candidate, source, target)) return candidate;
              }
            }
          }
        }
      }
      return null;
    }
    function path(points, edge) {
      const number = (value) => Math.round(value * 10) / 10;
      const commands = points.map(([x, y], index) => (index ? 'L ' : 'M ') + number(x) + ' ' + number(y)).join(' ');
      const active = incoming?.view === map.view && edge.dataset.from === incoming.node && edge.dataset.to === current.node;
      fragment.append(element('path', {
        d: commands,
        class: [edge.dataset.kind === 'return' ? 'return' : edge.dataset.kind === 'cross' ? 'cross' : '', active ? 'active' : ''].filter(Boolean).join(' '),
        'data-from': edge.dataset.from, 'data-to': edge.dataset.to,
        fill: 'none', 'marker-end': 'url(#' + markerId + ')',
      }));
    }
    const edges = map.edges.filter((edge) => visible(edge)
      && (edge.dataset.targetView || map.view) === map.view
      && boxes.has(edge.dataset.from) && boxes.has(edge.dataset.to));
    edges.sort((a, b) => Number(a.classList.contains('active')) - Number(b.classList.contains('active')));
    for (const edge of edges) {
      const points = routeEdge(boxes.get(edge.dataset.from), boxes.get(edge.dataset.to), edge, map.edges.indexOf(edge));
      if (points) path(points, edge);
    }
    map.svg.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height);
    map.svg.setAttribute('width', String(bounds.width));
    map.svg.setAttribute('height', String(bounds.height));
    map.svg.replaceChildren(fragment);
  }

  explorer.classList.add('is-enhanced');
  const reference = explorer.querySelector('details.directory-reference');
  if (reference) reference.open = false;
  applyRoute(false);
  if (window.location.hash) {
    window.requestAnimationFrame(() => {
      maps.get(current.view).nodes.get(current.node).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    });
  }
  window.addEventListener('resize', scheduleDraw, { passive: true });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(explorer);
    for (const map of maps.values()) observer.observe(map.panel);
  }
  if (document.fonts) document.fonts.ready.then(scheduleDraw);
})();
`;
