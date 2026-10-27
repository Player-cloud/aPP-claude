// The Iterative Layer has no behaviour yet. This screen says so plainly
// instead of showing a mock dashboard (ROADMAP §15: no empty dashboards).
export function IterativeView() {
  return (
    <>
      <h1 className="page-title">Improvements</h1>
      <p className="page-lede">
        The Iterative Layer will observe how the platform performs and propose improvements for your approval. It is not built yet.
      </p>
      <section className="card">
        <h2 className="card-title">What comes first</h2>
        <ol className="muted">
          <li>Workflow telemetry and an improvement backlog in observe-and-recommend mode.</li>
          <li>Monitoring of updates to Claude, plugins, skills and MCP servers.</li>
        </ol>
        <p className="muted">The read-only inventory of your Claude Code tools, with conflict detection, is already available under Tools.</p>
        <p className="subtle">Nothing here changes the platform on its own. Every improvement goes through your approval and the normal review gates.</p>
      </section>
    </>
  );
}
