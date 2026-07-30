declare module 'itowns/widgets' {
  export class Navigation {
    constructor(view: unknown, options?: Record<string, unknown>);
    compass?: HTMLButtonElement;
    toggle3D?: HTMLButtonElement;
    zoomIn?: HTMLButtonElement;
    zoomOut?: HTMLButtonElement;
    domElement: HTMLDivElement;
  }

  export class Scale {
    constructor(view: unknown, options?: Record<string, unknown>);
    domElement: HTMLDivElement;
    update(): void;
  }

  export class Minimap {
    constructor(view: unknown, layer: unknown, options?: Record<string, unknown>);
    domElement: HTMLDivElement;
    view: unknown;
  }
}
