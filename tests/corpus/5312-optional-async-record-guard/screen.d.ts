export type Guard = () => boolean | Promise<boolean>;
export type Screen = { id: string; onBeforeExit?: Guard };
export declare function navigate(fromScreen: Screen | null): Promise<boolean>;
export type Cell = { set?: (value: boolean) => void };
export declare function update(cell: Cell): void;
