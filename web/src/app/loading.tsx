/** Shown at once while a page's data loads, so a click never waits on a blank screen. */
export default function Loading() {
  return (
    <div className="page-loading" aria-busy="true" aria-label="Loading">
      <span /><span /><span />
    </div>
  );
}
