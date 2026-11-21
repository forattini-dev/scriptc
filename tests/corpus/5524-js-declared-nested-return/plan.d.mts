export interface CellSize { width: number; height: number }
export interface PixelRect { x: number; y: number; width: number; height: number }
export interface Source { width: number; height: number; cellSize: CellSize }
export interface Plan { fit: string; cellSize: CellSize; visiblePixels: PixelRect }
export function plan(source: Source, options?: { fit?: string; shrink?: boolean }): Plan;
