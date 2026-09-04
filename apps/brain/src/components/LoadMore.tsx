import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

export function LoadMore({
  loaded,
  total,
  hasMore,
  loading,
  error,
  onLoadMore,
}: {
  readonly loaded: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly onLoadMore: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = trigger.current;
    if (element === null || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  return (
    <div className="load-more">
      <span>{loaded.toLocaleString()} of {total.toLocaleString()}</span>
      {error !== undefined && <small role="alert">{error}</small>}
      {hasMore && (
        <button ref={trigger} className="button button--secondary" type="button" onClick={onLoadMore} disabled={loading}>
          {loading && <LoaderCircle className="is-spinning" aria-hidden="true" />}
          {loading ? "Loading" : "Load more"}
        </button>
      )}
    </div>
  );
}
