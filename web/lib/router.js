/**
 * A hash router.
 *
 * The console is a static folder with no server rules, so the routes live in
 * the hash: `#/ledger`, `#/receipt/18`. A link to a receipt opens the same
 * page on any machine.
 */

/**
 * @typedef {{ name: string, params: string[] }} Route
 */

/**
 * Make a router.
 *
 * @param {Record<string, string>} routes A map of route names to the element
 *   that shows them.
 * @param {(route: Route) => void|Promise<void>} onRoute
 */
export function createRouter(routes, onRoute) {
  const parse = () => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    const [name, ...params] = hash.split('/').filter(Boolean);
    return { name: routes[name] ? name : Object.keys(routes)[0], params };
  };

  const show = async () => {
    const route = parse();
    const visible = new Set(
      Object.entries(routes)
        .filter(([name]) => name === route.name)
        .map(([, id]) => id),
    );
    for (const id of new Set(Object.values(routes))) {
      const node = document.getElementById(id);
      if (node) node.hidden = !visible.has(id);
    }
    for (const link of document.querySelectorAll('[data-route]')) {
      const active = link.getAttribute('data-route') === route.name;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    await onRoute(route);
  };

  window.addEventListener('hashchange', show);
  return { start: show, parse };
}

/**
 * The link to a route.
 *
 * @param {string} name
 * @param {...string} params
 */
export function href(name, ...params) {
  return `#/${[name, ...params].join('/')}`;
}
