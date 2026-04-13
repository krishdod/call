export default function LoadingShell() {
  return (
    <div className="app-shell" role="status" aria-live="polite">
      <div className="app-shell-inner">
        <div className="app-shell-logo" />
        <p className="app-shell-text">Loading…</p>
        <p className="app-shell-sub">If the server was asleep, it may take a moment.</p>
      </div>
    </div>
  );
}
