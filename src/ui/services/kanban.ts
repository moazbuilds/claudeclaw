import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const KANBAN_DIR = join(process.cwd(), ".claude", "claudeclaw");
const KANBAN_FILE = join(KANBAN_DIR, "kanban.json");

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  started_at?: string;
  completed_at?: string;
  agent_type?: string;
}

export interface KanbanBoard {
  columns: {
    todo: KanbanCard[];
    in_progress: KanbanCard[];
    done: KanbanCard[];
  };
}

const DEFAULT_BOARD: KanbanBoard = {
  columns: { todo: [], in_progress: [], done: [] },
};

export async function readKanban(): Promise<KanbanBoard> {
  try {
    if (!existsSync(KANBAN_FILE)) return structuredClone(DEFAULT_BOARD);
    const text = await Bun.file(KANBAN_FILE).text();
    const parsed = JSON.parse(text) as KanbanBoard;
    if (!parsed.columns) parsed.columns = { todo: [], in_progress: [], done: [] };
    if (!Array.isArray(parsed.columns.todo)) parsed.columns.todo = [];
    if (!Array.isArray(parsed.columns.in_progress)) parsed.columns.in_progress = [];
    if (!Array.isArray(parsed.columns.done)) parsed.columns.done = [];
    return parsed;
  } catch {
    return structuredClone(DEFAULT_BOARD);
  }
}

export async function writeKanban(board: KanbanBoard): Promise<void> {
  await mkdir(KANBAN_DIR, { recursive: true });
  await Bun.write(KANBAN_FILE, JSON.stringify(board, null, 2));
}

export async function addCardToColumn(
  column: keyof KanbanBoard["columns"],
  card: KanbanCard
): Promise<void> {
  const board = await readKanban();
  board.columns[column].unshift(card);
  await writeKanban(board);
}

export async function moveCard(
  id: string,
  toColumn: keyof KanbanBoard["columns"],
  patch?: Partial<KanbanCard>
): Promise<void> {
  const board = await readKanban();
  let card: KanbanCard | undefined;
  for (const col of Object.keys(board.columns) as Array<keyof KanbanBoard["columns"]>) {
    const idx = board.columns[col].findIndex((c) => c.id === id);
    if (idx !== -1) {
      card = board.columns[col].splice(idx, 1)[0];
      break;
    }
  }
  if (card) {
    Object.assign(card, patch ?? {});
    board.columns[toColumn].unshift(card);
    await writeKanban(board);
  }
}
