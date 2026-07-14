import type { BookConfig, BookNote } from "../../types/book.ts";

interface BookNotesState {
  config: BookConfig | null;
}

export const EMPTY_BOOK_NOTES: BookNote[] = [];

export const selectBookNotes = (state: BookNotesState): BookNote[] => state.config?.booknotes ?? EMPTY_BOOK_NOTES;
