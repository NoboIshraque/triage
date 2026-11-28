// Small DOM helpers for the phone app (no framework: the app is a few screens).

type Child = Node | string | null | undefined | false;

/** An element: h('button.primary', { onclick }, 'Scan'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tagAndId = 'div', ...classes] = spec.split('.');
  const [tag = 'div', id] = tagAndId.split('#');
  const element = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (id) {
    element.id = id;
  }
  for (const c of classes) {
    element.classList.add(c);
  }
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(element.dataset, value);
    } else if (key in element && typeof value !== 'string') {
      (element as unknown as Record<string, unknown>)[key] = value;
    } else {
      element.setAttribute(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child);
    }
  }
  return element;
}

/** Replaces an element's children. */
export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(
    ...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false),
  );
}

/** A short message at the bottom of the screen. */
export function toast(text: string, ms = 3000): void {
  const element = h('div.toast', { role: 'status' }, text);
  document.body.append(element);
  setTimeout(() => {
    element.remove();
  }, ms);
}
