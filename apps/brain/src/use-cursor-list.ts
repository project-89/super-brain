import { useCallback, useEffect, useRef, useState } from "react";

import type { CursorPage } from "./types";

export function useCursorList<T>(options: {
  readonly initialItems: readonly T[];
  readonly initialTotal: number;
  readonly initialCursor?: string;
  readonly keyOf: (item: T) => string;
  readonly loadPage: (cursor: string) => Promise<CursorPage<T>>;
}) {
  const [items, setItems] = useState<readonly T[]>(options.initialItems);
  const [total, setTotal] = useState(options.initialTotal);
  const [cursor, setCursor] = useState(options.initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const loadPage = useRef(options.loadPage);
  const keyOf = useRef(options.keyOf);
  loadPage.current = options.loadPage;
  keyOf.current = options.keyOf;

  useEffect(() => {
    setItems(options.initialItems);
    setTotal(options.initialTotal);
    setCursor(options.initialCursor);
    setLoadError(undefined);
  }, [options.initialCursor, options.initialItems, options.initialTotal]);

  const loadMore = useCallback(async () => {
    if (cursor === undefined || loadingMore) return;
    setLoadingMore(true);
    setLoadError(undefined);
    try {
      const page = await loadPage.current(cursor);
      setItems((current) => {
        const seen = new Set(current.map((item) => keyOf.current(item)));
        return [...current, ...page.items.filter((item) => !seen.has(keyOf.current(item)))];
      });
      setTotal(page.total);
      setCursor(page.nextCursor);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load more records");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  return { items, total, cursor, loadingMore, loadError, loadMore };
}
