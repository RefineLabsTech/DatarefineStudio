declare module "tabulator-tables" {
  export type CellComponent = {
    getRow: () => {
      getData: () => { _r?: number } & Record<string, unknown>;
      getCells?: () => CellComponent[];
    };
    getField: () => string;
    getElement: () => HTMLElement;
    getValue: () => unknown;
    setValue?: (value: unknown, mutate?: boolean) => void;
  };

  export type ColumnComponent = {
    getField: () => string;
    getWidth: () => number;
    getElement: () => HTMLElement;
    getTable: () => TabulatorFull;
    hide: () => void;
  };

  export type RangeComponent = {
    getCells: () => CellComponent[];
    getStructuredCells: () => CellComponent[][];
    getRows: () => unknown[];
    getColumns: () => unknown[];
    getBounds: () => unknown;
    setEndBound: (cell: CellComponent) => void;
    setBounds: (start: CellComponent, end: CellComponent) => void;
  };

  export type ColumnDefinition = {
    title?: string;
    field?: string;
    width?: number;
    minWidth?: number;
    frozen?: boolean;
    headerSort?: boolean;
    headerFilter?: string | boolean;
    headerFilterPlaceholder?: string;
    headerMenu?: unknown;
    headerTooltip?: string;
    hozAlign?: string;
    vertAlign?: string;
    cssClass?: string;
    formatter?: (cell: CellComponent) => unknown;
    titleFormatter?: () => unknown;
    editor?:
      | string
      | boolean
      | ((
          cell: CellComponent,
          onRendered: (callback: () => void) => void,
          success: (value: unknown) => void,
          cancel: () => void,
        ) => HTMLElement);
    editable?: boolean;
    resizable?: boolean;
    sorter?: string;
    clipboard?: boolean;
  };

  export class TabulatorFull {
    constructor(element: HTMLElement, options?: Record<string, unknown>);
    element: HTMLElement;
    options: Record<string, unknown>;
    on(event: string, callback: (...args: any[]) => void): void;
    redraw(force?: boolean): void;
    destroy(): void;
    updateData(data: Record<string, unknown>[]): Promise<unknown>;
    replaceData(data: Record<string, unknown>[]): Promise<unknown>;
    getColumns(): ColumnComponent[];
    setSort(field: string | Array<{ column?: string; field?: string; dir: string }>, dir?: string): void;
    setGroupBy(field: string | boolean): void;
    setFilter(field: string, type: string, value: unknown): void;
    clearFilter(silent?: boolean): void;
    getColumn(field: string): ColumnComponent;
    getRow(index: number | string): { getData: () => { _r?: number } & Record<string, unknown>; getCells?: () => CellComponent[] } | false;
    getRows(type?: string): Array<{ getData?: () => { _r?: number } & Record<string, unknown>; getCells: () => CellComponent[] }>;
    getRanges(): RangeComponent[];
    getSorters(): Array<{ field: string; dir: string }>;
    getFilters(all?: boolean): Array<{ field: string; type: string; value: unknown }>;
  }
}

declare module "tabulator-tables/dist/css/tabulator.min.css";
declare module "../vendor/tabulator-tables/tabulator.min.css";
declare module "../vendor/tabulator-tables/tabulator_esm.min.mjs" {
  export { TabulatorFull, type CellComponent, type ColumnDefinition } from "tabulator-tables";
}
